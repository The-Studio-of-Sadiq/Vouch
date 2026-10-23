import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

// One hidden chunk of a message. The plaintext never enters the DOM: it is
// painted on canvases only while the chunk is held.
//
// Touch/mouse: only the few characters under the finger are revealed, and
// they're drawn in a small magnifier above the finger (the fingertip would
// cover them otherwise). The window goes wherever the finger goes, at whatever
// speed, so a camera filming the screen gets an unpredictable trickle of
// fragments instead of a steady, reconstructable sweep.
//
// Keyboard: no finger to follow, so a window sweeps across automatically.
//
// A chunk counts as fully read once every non-space character has been under
// the window during a single hold.

const FONT_SIZE = 15;
const LINE_H = 22;
const PAD_X = 6;
const PAD_Y = 3;
const APERTURE_CHARS = 3.5;
const KEY_MS_PER_CHAR = 70;
const LENS_ZOOM = 2;
const LENS_PAD = 6;
const LENS_GAP = 28; // px between the lens and the line under the finger

interface Line {
  text: string;
  width: number;
  charX: number[]; // centre of each character, from the line's left edge
  first: number; // global index of this line's first character
}

interface Geometry {
  lines: Line[];
  total: number; // sum of line widths (keyboard sweep path)
  charW: number;
  font: string;
  required: number[]; // global indices of non-space characters
}

interface Props {
  text: string;
  index: number;
  read: boolean;
  maxWidth: number;
  /** Called once per hold that revealed anything; `full` if every character was seen. */
  onView: (full: boolean) => void;
}

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function layout(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, font: string): Geometry {
  const rows: string[] = [];
  let current = '';
  for (const word of text.split(' ')) {
    const next = current ? `${current} ${word}` : word;
    if (current && ctx.measureText(next).width > maxWidth) {
      rows.push(current);
      current = word;
    } else current = next;
  }
  if (current) rows.push(current);

  const lines: Line[] = [];
  const required: number[] = [];
  let first = 0;
  let total = 0;
  for (const row of rows) {
    const charX: number[] = [];
    for (let i = 0; i < row.length; i++) {
      const left = ctx.measureText(row.slice(0, i)).width;
      const right = ctx.measureText(row.slice(0, i + 1)).width;
      charX.push((left + right) / 2);
      if (row[i] !== ' ') required.push(first + i);
    }
    const width = Math.ceil(ctx.measureText(row).width);
    lines.push({ text: row, width, charX, first });
    first += row.length;
    total += width;
  }
  return { lines, total, charW: total / Math.max(1, text.length), font, required };
}

export function RevealChunk({ text, index, read, maxWidth, onView }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const geo = useRef<Geometry | undefined>(undefined);
  const lens = useRef<HTMLCanvasElement | null>(null);
  const raf = useRef(0);
  const mode = useRef<'pointer' | 'key' | null>(null);
  const seen = useRef(new Set<number>());
  const onViewRef = useRef(onView);
  onViewRef.current = onView;
  const readRef = useRef(read);
  readRef.current = read;

  const ctxOf = (c: HTMLCanvasElement, zoom = 1) => {
    const ctx = c.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, 0, 0);
    return ctx;
  };

  // Masked state, optionally with an outline where the window currently is.
  const drawMask = useCallback((marker?: { line: number; from: number; to: number }) => {
    const c = canvasRef.current;
    const g = geo.current;
    if (!c || !g) return;
    const ctx = ctxOf(c);
    ctx.clearRect(0, 0, c.width, c.height);
    const hatch = cssVar('--mask-hatch');
    ctx.fillStyle = cssVar(readRef.current ? '--mask-read' : '--mask');
    g.lines.forEach((l, i) => {
      const y = PAD_Y + i * LINE_H;
      const w = l.width + PAD_X * 2;
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(0, y, w, LINE_H - 2, 6);
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
    if (marker) {
      ctx.strokeStyle = cssVar('--accent');
      ctx.lineWidth = 2;
      ctx.strokeRect(PAD_X + marker.from, PAD_Y + marker.line * LINE_H + 1, marker.to - marker.from, LINE_H - 4);
    }
  }, []);

  // Marks the characters whose centres fall inside [from, to] on a line.
  const markSeen = (line: Line, from: number, to: number) => {
    line.charX.forEach((x, i) => {
      if (x >= from && x <= to) seen.current.add(line.first + i);
    });
  };

  // Keyboard sweep: draws the revealed slice in place on the chunk itself.
  const drawInPlace = useCallback(
    (pos: number) => {
      const g = geo.current;
      const c = canvasRef.current;
      if (!g || !c) return;
      drawMask();
      const ctx = ctxOf(c);
      const half = (g.charW * APERTURE_CHARS) / 2;
      ctx.font = g.font;
      ctx.textBaseline = 'middle';
      let offset = 0;
      g.lines.forEach((l, i) => {
        const a = Math.max(pos - half, offset);
        const b = Math.min(pos + half, offset + l.width);
        offset += l.width;
        if (b <= a) return;
        markSeen(l, a - (offset - l.width), b - (offset - l.width));
        const y = PAD_Y + i * LINE_H;
        const x0 = PAD_X + (a - (offset - l.width));
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0, y, b - a, LINE_H - 2);
        ctx.clip();
        ctx.fillStyle = cssVar('--reveal-bg');
        ctx.fillRect(x0, y, b - a, LINE_H - 2);
        ctx.fillStyle = cssVar('--reveal-fg');
        ctx.fillText(l.text, PAD_X, y + (LINE_H - 2) / 2);
        ctx.restore();
      });
    },
    [drawMask],
  );

  // Finger: reveal around the finger's position, shown magnified above it.
  const follow = useCallback(
    (clientX: number, clientY: number) => {
      const g = geo.current;
      const c = canvasRef.current;
      const lc = lens.current;
      if (!g || !c || !lc) return;
      const rect = c.getBoundingClientRect();
      const lineIdx = Math.min(g.lines.length - 1, Math.max(0, Math.floor((clientY - rect.top - PAD_Y) / LINE_H)));
      const line = g.lines[lineIdx];
      const half = (g.charW * APERTURE_CHARS) / 2;
      const centre = Math.min(line.width, Math.max(0, clientX - rect.left - PAD_X));
      const from = Math.max(0, centre - half);
      const to = Math.min(line.width, centre + half);
      markSeen(line, from, to);
      drawMask({ line: lineIdx, from, to });

      // Lens: a fixed-size window onto [centre - half, centre + half], zoomed.
      const cssW = (half * 2 + LENS_PAD * 2) * LENS_ZOOM;
      const cssH = (LINE_H + LENS_PAD) * LENS_ZOOM;
      const lineTop = rect.top + PAD_Y + lineIdx * LINE_H;
      const left = Math.min(window.innerWidth - cssW - 8, Math.max(8, clientX - cssW / 2));
      const top = Math.max(8, lineTop - cssH - LENS_GAP);
      lc.style.left = `${left}px`;
      lc.style.top = `${top}px`;
      const ctx = ctxOf(lc, LENS_ZOOM);
      const w = cssW / LENS_ZOOM;
      const h = cssH / LENS_ZOOM;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = cssVar('--reveal-bg');
      ctx.beginPath();
      ctx.roundRect(0, 0, w, h, 6);
      ctx.fill();
      ctx.save();
      ctx.beginPath();
      ctx.rect(LENS_PAD, 0, half * 2, h);
      ctx.clip();
      ctx.font = g.font;
      ctx.textBaseline = 'middle';
      ctx.fillStyle = cssVar('--reveal-fg');
      ctx.fillText(line.text, LENS_PAD - (centre - half), h / 2);
      ctx.restore();
    },
    [drawMask],
  );

  useLayoutEffect(() => {
    const c = canvasRef.current!;
    const ctx = c.getContext('2d')!;
    const font = `500 ${FONT_SIZE}px ${getComputedStyle(c).fontFamily}`;
    ctx.font = font;
    const g = layout(ctx, text, maxWidth - PAD_X * 2, font);
    geo.current = g;
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
    if (!mode.current) drawMask();
  }, [read, drawMask]);

  const stop = useCallback(() => {
    if (!mode.current) return;
    mode.current = null;
    cancelAnimationFrame(raf.current);
    lens.current?.remove();
    lens.current = null;
    drawMask();
    const g = geo.current;
    if (g && seen.current.size) onViewRef.current(g.required.every((i) => seen.current.has(i)));
    seen.current = new Set();
  }, [drawMask]);

  const startPointer = (clientX: number, clientY: number) => {
    const g = geo.current;
    if (!g || mode.current) return;
    mode.current = 'pointer';
    seen.current = new Set();
    const half = (g.charW * APERTURE_CHARS) / 2;
    const lc = document.createElement('canvas');
    const cssW = (half * 2 + LENS_PAD * 2) * LENS_ZOOM;
    const cssH = (LINE_H + LENS_PAD) * LENS_ZOOM;
    const dpr = window.devicePixelRatio || 1;
    lc.width = Math.ceil(cssW * dpr);
    lc.height = Math.ceil(cssH * dpr);
    lc.style.width = `${cssW}px`;
    lc.style.height = `${cssH}px`;
    lc.className = 'reveal-lens';
    lc.setAttribute('aria-hidden', 'true');
    document.body.appendChild(lc);
    lens.current = lc;
    follow(clientX, clientY);
  };

  const startKeys = () => {
    const g = geo.current;
    if (!g || mode.current) return;
    mode.current = 'key';
    seen.current = new Set();
    const half = (g.charW * APERTURE_CHARS) / 2;
    const span = g.total + half * 2;
    const t0 = performance.now();
    const tick = (now: number) => {
      if (mode.current !== 'key') return;
      const travelled = ((now - t0) / KEY_MS_PER_CHAR) * g.charW;
      drawInPlace((travelled % span) - half);
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  };

  useEffect(() => {
    const onHide = () => stop();
    window.addEventListener('capture-shield', onHide);
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('blur', onHide);
    return () => {
      window.removeEventListener('capture-shield', onHide);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('blur', onHide);
      stop();
    };
  }, [stop]);

  return (
    <canvas
      ref={canvasRef}
      className="chunk"
      role="button"
      tabIndex={0}
      aria-label={`Hidden part ${index + 1}${read ? ', read' : ''}. Press and hold, then slide your finger across to reveal it.`}
      onPointerDown={(e) => {
        e.preventDefault();
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // Synthetic or already-released pointer; following still works.
        }
        startPointer(e.clientX, e.clientY);
      }}
      onPointerMove={(e) => {
        if (mode.current === 'pointer') follow(e.clientX, e.clientY);
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      onKeyDown={(e) => {
        if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
          e.preventDefault();
          startKeys();
        }
      }}
      onKeyUp={(e) => {
        if (e.key === ' ' || e.key === 'Enter') stop();
      }}
      onContextMenu={(e) => e.preventDefault()}
    />
  );
}
