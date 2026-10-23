import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

// One hidden chunk of a message. The plaintext never enters the DOM: it is
// painted on a canvas, and only while the chunk is being held. Even then, only
// a narrow window of a few characters is visible at once, sliding across the
// words, so a single screenshot or video frame shows a fragment at most.

const FONT_SIZE = 15;
const LINE_H = 22;
const PAD_X = 6;
const PAD_Y = 3;
const MS_PER_CHAR = 70;
const APERTURE_CHARS = 4;

interface Line {
  text: string;
  width: number;
  offset: number; // position along the concatenated sweep path
}

interface Props {
  text: string;
  index: number;
  read: boolean;
  maxWidth: number;
  onRead: () => void;
}

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function layout(ctx: CanvasRenderingContext2D, text: string, maxWidth: number) {
  const lines: Line[] = [];
  let current = '';
  for (const word of text.split(' ')) {
    const next = current ? `${current} ${word}` : word;
    if (current && ctx.measureText(next).width > maxWidth) {
      lines.push({ text: current, width: 0, offset: 0 });
      current = word;
    } else current = next;
  }
  if (current) lines.push({ text: current, width: 0, offset: 0 });
  let offset = 0;
  for (const l of lines) {
    l.width = Math.ceil(ctx.measureText(l.text).width);
    l.offset = offset;
    offset += l.width;
  }
  return { lines, total: offset, charW: offset / Math.max(1, text.length) };
}

export function RevealChunk({ text, index, read, maxWidth, onRead }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const geo = useRef<(ReturnType<typeof layout> & { font: string }) | undefined>(undefined);
  const raf = useRef(0);
  const holding = useRef(false);
  const onReadRef = useRef(onRead);
  onReadRef.current = onRead;
  const readRef = useRef(read);
  readRef.current = read;

  const ctx2d = () => {
    const c = canvasRef.current!;
    const ctx = c.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  };

  const drawMask = useCallback(() => {
    const c = canvasRef.current;
    const g = geo.current;
    if (!c || !g) return;
    const ctx = ctx2d();
    ctx.clearRect(0, 0, c.width, c.height);
    const mask = cssVar(readRef.current ? '--mask-read' : '--mask');
    const hatch = cssVar('--mask-hatch');
    g.lines.forEach((l, i) => {
      const x = 0;
      const y = PAD_Y + i * LINE_H;
      const w = l.width + PAD_X * 2;
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(x, y, w, LINE_H - 2, 6);
      ctx.fillStyle = mask;
      ctx.fill();
      ctx.clip();
      ctx.strokeStyle = hatch;
      ctx.lineWidth = 1;
      for (let hx = -LINE_H; hx < w + LINE_H; hx += 6) {
        ctx.beginPath();
        ctx.moveTo(hx, y + LINE_H);
        ctx.lineTo(hx + LINE_H, y);
        ctx.stroke();
      }
      ctx.restore();
    });
  }, []);

  const drawAperture = useCallback(
    (pos: number) => {
      const g = geo.current;
      if (!g) return;
      drawMask();
      const ctx = ctx2d();
      const half = (g.charW * APERTURE_CHARS) / 2;
      const from = pos - half;
      const to = pos + half;
      ctx.font = g.font;
      ctx.textBaseline = 'middle';
      g.lines.forEach((l, i) => {
        const a = Math.max(from, l.offset);
        const b = Math.min(to, l.offset + l.width);
        if (b <= a) return;
        const y = PAD_Y + i * LINE_H;
        const x0 = PAD_X + (a - l.offset);
        const w = b - a;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0, y, w, LINE_H - 2);
        ctx.clip();
        ctx.fillStyle = cssVar('--reveal-bg');
        ctx.fillRect(x0, y, w, LINE_H - 2);
        ctx.fillStyle = cssVar('--reveal-fg');
        ctx.fillText(l.text, PAD_X, y + (LINE_H - 2) / 2);
        ctx.restore();
      });
    },
    [drawMask],
  );

  useLayoutEffect(() => {
    const c = canvasRef.current!;
    const ctx = c.getContext('2d')!;
    const font = `500 ${FONT_SIZE}px ${getComputedStyle(c).fontFamily}`;
    ctx.font = font;
    const g = layout(ctx, text, maxWidth - PAD_X * 2);
    geo.current = { ...g, font };
    const w = Math.max(...g.lines.map((l) => l.width)) + PAD_X * 2;
    const h = g.lines.length * LINE_H + PAD_Y * 2;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.ceil(w * dpr);
    c.height = Math.ceil(h * dpr);
    c.style.width = `${w}px`;
    c.style.height = `${h}px`;
    drawMask();
  }, [text, maxWidth, drawMask]);

  useEffect(() => {
    if (!holding.current) drawMask();
  }, [read, drawMask]);

  const stop = useCallback(() => {
    holding.current = false;
    cancelAnimationFrame(raf.current);
    drawMask();
  }, [drawMask]);

  const start = useCallback(() => {
    const g = geo.current;
    if (!g || holding.current) return;
    holding.current = true;
    const half = (g.charW * APERTURE_CHARS) / 2;
    const span = g.total + half * 2;
    const t0 = performance.now();
    let reported = false;
    const tick = (now: number) => {
      if (!holding.current) return;
      const travelled = ((now - t0) / MS_PER_CHAR) * g.charW;
      // A chunk counts as read once the window has swept all of it.
      if (!reported && travelled >= span) {
        reported = true;
        onReadRef.current();
      }
      drawAperture((travelled % span) - half);
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  }, [drawAperture]);

  useEffect(() => {
    const onHide = () => stop();
    window.addEventListener('capture-shield', onHide);
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('blur', onHide);
    return () => {
      window.removeEventListener('capture-shield', onHide);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('blur', onHide);
      cancelAnimationFrame(raf.current);
    };
  }, [stop]);

  return (
    <canvas
      ref={canvasRef}
      className="chunk"
      role="button"
      tabIndex={0}
      aria-label={`Hidden part ${index + 1}${read ? ', read' : ''}. Press and hold to reveal.`}
      onPointerDown={(e) => {
        e.preventDefault();
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // Synthetic or already-released pointer; holding still works.
        }
        start();
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      onKeyDown={(e) => {
        if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
          e.preventDefault();
          start();
        }
      }}
      onKeyUp={(e) => {
        if (e.key === ' ' || e.key === 'Enter') stop();
      }}
      onContextMenu={(e) => e.preventDefault()}
    />
  );
}
