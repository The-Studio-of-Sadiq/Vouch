import { useEffect, useState } from 'react';

// Best-effort capture deterrence. A web page cannot stop OS-level screenshots
// or a camera pointed at the screen; what it can do is make sure nothing
// readable is on screen when a capture tool is likely in use:
//  - blank everything when the window loses focus or the tab is hidden
//    (snipping tools, screen recorders' pickers and app switchers all do this)
//  - blank on Print Screen and the macOS/Windows screenshot shortcuts
//  - block printing, text selection, dragging and the context menu
// For true OS-level blocking, ship inside a native shell that sets
// FLAG_SECURE on Android / hides content while UIScreen.isCaptured on iOS.

export function CaptureShield() {
  const [shielded, setShielded] = useState(() => typeof document !== 'undefined' && !document.hasFocus());

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const raise = (holdMs = 0) => {
      setShielded(true);
      window.dispatchEvent(new Event('capture-shield'));
      clearTimeout(timer);
      if (holdMs) timer = setTimeout(() => document.hasFocus() && !document.hidden && setShielded(false), holdMs);
    };
    const lower = () => {
      if (!document.hidden && document.hasFocus()) setShielded(false);
    };

    const isCaptureShortcut = (e: KeyboardEvent) =>
      e.key === 'PrintScreen' ||
      (e.metaKey && e.shiftKey && ['3', '4', '5', 's', 'S'].includes(e.key)) || // macOS / Win+Shift+S
      (e.ctrlKey && e.key === 'p');

    const onKey = (e: KeyboardEvent) => {
      if (!isCaptureShortcut(e)) return;
      e.preventDefault();
      raise(1500);
      // Print Screen copies to the clipboard on Windows; overwrite it.
      navigator.clipboard?.writeText('').catch(() => {});
    };
    const onMeta = (e: KeyboardEvent) => {
      // Holding a modifier that starts a screenshot chord: hide pre-emptively.
      if (e.key === 'Meta' || e.key === 'OS') raise(1200);
    };
    const onVisibility = () => (document.hidden ? raise() : lower());
    const block = (e: Event) => e.preventDefault();
    const onBlur = () => raise();

    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', lower);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    window.addEventListener('keydown', onMeta, true);
    window.addEventListener('beforeprint', onBlur);
    document.addEventListener('contextmenu', block);
    document.addEventListener('dragstart', block);
    document.addEventListener('copy', block);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('beforeprint', onBlur);
      window.removeEventListener('focus', lower);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
      window.removeEventListener('keydown', onMeta, true);
      document.removeEventListener('contextmenu', block);
      document.removeEventListener('dragstart', block);
      document.removeEventListener('copy', block);
    };
  }, []);

  if (!shielded) return null;
  return (
    <div className="shield" onPointerDown={() => document.hasFocus() && setShielded(false)}>
      <div className="shield-card">
        <div className="shield-icon" aria-hidden>◈</div>
        <p>Content hidden</p>
        <small>Click to return to the conversation.</small>
      </div>
    </div>
  );
}
