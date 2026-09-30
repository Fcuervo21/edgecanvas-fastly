import { SIZE } from '../game/rules';
import type { Point } from '../game/types';
export interface PaintActions {
  continuous(): boolean;
  apply(point: Point): void;
  stroke(points: Point[]): boolean;
  hover(point: Point | null): void;
}
export function pointToCell(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }): { x: number; y: number } | null {
  if (![clientX, clientY, rect.left, rect.top, rect.width, rect.height].every(Number.isFinite)
    || rect.width <= 0 || rect.height <= 0 || clientX < rect.left || clientY < rect.top
    || clientX >= rect.left + rect.width || clientY >= rect.top + rect.height) return null;
  return { x: Math.floor((clientX - rect.left) / rect.width * SIZE), y: Math.floor((clientY - rect.top) / rect.height * SIZE) };
}

// Fill the cells between sampled pointer positions, including diagonal strokes.
function line(from: Point, to: Point): Point[] {
  const points: Point[] = [];
  let { x, y } = from;
  const dx = Math.abs(to.x - x), dy = -Math.abs(to.y - y);
  const sx = x < to.x ? 1 : -1, sy = y < to.y ? 1 : -1;
  let error = dx + dy;
  while (x !== to.x || y !== to.y) {
    const twice = 2 * error;
    if (twice >= dy) { error += dy; x += sx; }
    if (twice <= dx) { error += dx; y += sy; }
    points.push({ x, y });
  }
  return points;
}
export function bindPainting(canvas: HTMLCanvasElement, actions: PaintActions) {
  let pointer: number | null = null;
  let last: Point | null = null;
  let drawing = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Map<number, Point>();
  const point = (e: PointerEvent) => pointToCell(e.clientX, e.clientY, canvas.getBoundingClientRect());
  function stop() {
    const id = pointer;
    pointer = null; last = null; drawing = false;
    clearTimeout(timer); timer = undefined; pending.clear();
    if (id !== null && canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
  }
  function flush() {
    clearTimeout(timer); timer = undefined;
    if (!pending.size) return;
    const points = [...pending.values()]; pending.clear();
    if (!actions.stroke(points)) stop();
  }
  function extend(next: Point) {
    if (!last || !drawing) return;
    for (const p of line(last, next)) pending.set(p.y * SIZE + p.x, p);
    last = next;
    // Save/render at most 20 times per second while dragging, not once per pixel.
    if (pending.size && timer === undefined) timer = setTimeout(flush, 50);
  }
  canvas.addEventListener('pointerdown', e => {
    if (!e.isPrimary || e.button !== 0 || pointer !== null) return;
    const next = point(e); if (!next) return;
    e.preventDefault(); canvas.focus({ preventScroll: true });
    pointer = e.pointerId; last = next; drawing = actions.continuous();
    canvas.setPointerCapture(pointer); actions.hover(next);
    if (drawing) { pending.set(next.y * SIZE + next.x, next); flush(); }
    else actions.apply(next);
  });
  canvas.addEventListener('pointermove', e => {
    if (!e.isPrimary || (pointer !== null && e.pointerId !== pointer)) return;
    const next = point(e); actions.hover(next);
    if (pointer === null) return;
    if (!(e.buttons & 1) || !next) { stop(); return; }
    extend(next);
  });
  canvas.addEventListener('pointerup', e => {
    if (e.pointerId !== pointer) return;
    const next = point(e);
    if (next && drawing) { extend(next); flush(); }
    stop();
  });
  for (const event of ['pointercancel', 'lostpointercapture'] as const) canvas.addEventListener(event, e => { if (e.pointerId === pointer) stop(); });
  canvas.addEventListener('pointerleave', e => {
    if (!e.isPrimary || (pointer !== null && e.pointerId !== pointer)) return;
    actions.hover(null); stop();
  });
  canvas.addEventListener('blur', stop);
  canvas.addEventListener('keydown', e => { if (e.key === 'Escape') stop(); });
  window.addEventListener('blur', stop);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
  return { stop };
}
