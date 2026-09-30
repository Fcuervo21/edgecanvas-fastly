import { SIZE } from '../game/rules';
import { BRUSH_MASKS, previewTargets, paintCost } from '../game/targets';
import { teamColor } from '../rooms/colors';
import type { RoomEffect } from '../rooms/types';
import { bindPainting } from './pointer';
import { scheduleReveal } from './reveal';
import { drawShieldBadge, shieldRegions } from './shields';
import type { BrushShape, GameState, Point, Tool } from '../game/types';

export { pointToCell } from './pointer';

type Particle = { x: number; y: number; vx: number; vy: number; born: number; size: number; color: string };
export function createCanvas(canvas: HTMLCanvasElement, apply: (x: number, y: number) => void,
  hover: (point: { x: number; y: number } | null, count: number, price: number) => void, stroke: (points: Point[]) => boolean) {
  const ctx = canvas.getContext('2d')!;
  let state: GameState;
  let shields: ReturnType<typeof shieldRegions> = [];
  let tool: Tool = 'brush';
  let shape: BrushShape = 'pixel';
  let ripples: { x: number; y: number; born: number; color: string }[] = [];
  let cursor: { x: number; y: number } | null = null;
  let particles: Particle[] = [];
  /** Pixels that arrived from other players and are being revealed one after another: what to show until `at`. */
  const hidden = new Map<number, { prev: { owner: string | null; shieldUntil: number }; at: number }>();
  /** When the last scheduled reveal finishes: a burst that arrives as several events keeps drawing one after another. */
  let revealEnd = 0;
  let animation = 0;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  function draw(now = performance.now()) {
    animation = 0;
    if (!state) return;
    const w = canvas.width;
    const unit = w / SIZE;
    const badgeSize = Math.max(18 * w / Math.max(1, canvas.getBoundingClientRect().width), unit * 2.5);
    ctx.clearRect(0, 0, w, w);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, w);
    for (let i = 0; i < state.cells.length; i++) {
      let cell = state.cells[i];
      const waiting = hidden.get(i);
      if (waiting) { if (now >= waiting.at) hidden.delete(i); else cell = waiting.prev; }
      const x = (i % SIZE) * unit, y = Math.floor(i / SIZE) * unit;
      if (cell.owner) {
        ctx.fillStyle = teamColor(cell.owner);
        ctx.fillRect(x, y, unit, unit);
        if (cell.shieldUntil > state.minute) {
          ctx.fillStyle = '#65c9ff';
          ctx.fillRect(x + unit * .16, y + unit * .16, unit * .68, unit * .68);
          ctx.strokeStyle = '#2463db';
          ctx.lineWidth = Math.max(1, unit * .12);
          ctx.strokeRect(x + unit * .08, y + unit * .08, unit * .84, unit * .84);
        }
      } else {
        ctx.fillStyle = '#dfe3e9';
        ctx.fillRect(x + unit * .46, y + unit * .46, Math.max(1, unit * .1), Math.max(1, unit * .1));
      }
    }
    if (cursor) {
      const targets = previewTargets(state, tool, cursor.x, cursor.y, shape);
      ctx.fillStyle = tool === 'shield' ? '#65c9ffbb' : teamColor(state.team);
      ctx.globalAlpha = .35;
      targets.forEach(i => ctx.fillRect(i % SIZE * unit, Math.floor(i / SIZE) * unit, unit, unit));
      ctx.globalAlpha = 1;
      const radius = tool === 'bomb' ? 2 : tool === 'shield' ? 1 : Math.floor(BRUSH_MASKS[shape].length / 2);
      ctx.strokeStyle = targets.length ? '#252932' : '#c91520';
      ctx.lineWidth = Math.max(1.5, w / 700);
      if (tool === 'shield' && targets.length) {
        ctx.strokeStyle = '#2463db';
        for (const i of targets) ctx.strokeRect(i % SIZE * unit, Math.floor(i / SIZE) * unit, unit, unit);
        drawShieldBadge(ctx, Math.max(badgeSize / 2, Math.min(w - badgeSize / 2, (cursor.x + .5) * unit)), Math.max(badgeSize / 2, (cursor.y - 2) * unit), badgeSize);
      } else if (tool === 'brush' && shape !== 'pixel') {
        for (const i of targets) ctx.strokeRect(i % SIZE * unit, Math.floor(i / SIZE) * unit, unit, unit);
      } else ctx.strokeRect(Math.max(0, cursor.x - radius) * unit, Math.max(0, cursor.y - radius) * unit,
        (Math.min(99, cursor.x + radius) - Math.max(0, cursor.x - radius) + 1) * unit,
        (Math.min(99, cursor.y + radius) - Math.max(0, cursor.y - radius) + 1) * unit);
    }
    for (const region of shields) {
      const x = (region.anchor % SIZE + .5) * unit;
      const y = (Math.floor(region.anchor / SIZE) + .5) * unit;
      drawShieldBadge(ctx, Math.max(badgeSize / 2, Math.min(w - badgeSize / 2, x)), Math.max(badgeSize / 2, Math.min(w - badgeSize / 2, y)), badgeSize);
    }
    particles = reduced.matches ? [] : particles.filter(p => now - p.born < 500);
    for (const p of particles) {
      const age = (now - p.born) / 500;
      ctx.globalAlpha = 1 - age;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc((p.x + p.vx * age) * unit, (p.y + p.vy * age + age * age * 2) * unit, p.size * unit * (1 - age * .7), 0, Math.PI * 2);
      ctx.fill();
    }
    ripples = reduced.matches ? [] : ripples.filter(r => now - r.born < 650);
    for (const r of ripples) {
      const age = (now - r.born) / 650;
      ctx.globalAlpha = (1 - age) * .8;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = Math.max(1.5, unit * .3) * (1 - age * .5);
      ctx.beginPath(); ctx.arc(r.x * unit, r.y * unit, (2 + age * 7) * unit, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = r.color;
      ctx.font = `900 ${Math.max(13, unit * 2.2)}px "Avenir Next", sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('SPLAT!', r.x * unit, (r.y - 4 - age * 3) * unit);
    }
    ctx.globalAlpha = 1;
    if (particles.length || ripples.length || hidden.size) animation = requestAnimationFrame(draw);
  }
  function redraw() { if (!animation) animation = requestAnimationFrame(draw); }
  function notify() { const targets = cursor && state ? previewTargets(state, tool, cursor.x, cursor.y, shape) : []; hover(cursor, targets.length, state ? paintCost(state, targets) : 0); redraw(); }
  const painting = bindPainting(canvas, {
    continuous: () => tool === 'brush' && shape === 'pixel',
    apply: p => apply(p.x, p.y), stroke,
    hover: p => { cursor = p; notify(); },
  });
  canvas.addEventListener('focus', () => { cursor ??= { x: 50, y: 50 }; notify(); });
  canvas.addEventListener('blur', () => { cursor = null; notify(); });
  canvas.addEventListener('keydown', e => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', ' '].includes(e.key)) return;
    e.preventDefault();
    if (e.repeat) return;
    cursor ??= { x: 50, y: 50 };
    if (e.key === 'Enter' || e.key === ' ') apply(cursor.x, cursor.y);
    else {
      cursor.x = Math.max(0, Math.min(99, cursor.x + (e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0)));
      cursor.y = Math.max(0, Math.min(99, cursor.y + (e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0)));
    }
    notify();
  });
  new ResizeObserver(() => {
    const width = Math.round(canvas.getBoundingClientRect().width * (window.devicePixelRatio || 1));
    if (canvas.width !== width) canvas.width = canvas.height = width;
    redraw();
  }).observe(canvas);
  reduced.addEventListener('change', redraw);
  return {
    /** Plays a bomb or shield another player used, at the spot and in the color it really had. */
    effect(fx: RoomEffect) {
      if (reduced.matches) return;
      const now = performance.now(), radius = fx.tool === 'bomb' ? 2 : 1, color = fx.tool === 'shield' ? '#38b9f4' : teamColor(fx.team);
      if (fx.tool === 'bomb') ripples = [...ripples, { x: fx.x + .5, y: fx.y + .5, born: now, color }].slice(-6);
      for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) for (let j = 0; j < 4; j++) particles.push({
        x: fx.x + dx + .5, y: fx.y + dy + .5, vx: (Math.random() - .5) * 6, vy: (Math.random() - .5) * 6, born: now, size: .15 + Math.random() * .3, color,
      });
      particles = particles.slice(-300); redraw();
    },
    /**
     * `changed`: cells others changed (or the server confirmed). `local`: cells your own unconfirmed moves just changed.
     * With `local` given, others' pixels that really differ from what is on screen are revealed one after another
     * instead of all at once, and only your own cells get the splash effects.
     */
    update(next: GameState, selected: Tool, changed: number[] = [], selectedShape: BrushShape = 'pixel', local?: number[]) {
      if (selected !== tool || selectedShape !== shape) painting.stop();
      if (!state || next.cells !== state.cells || next.minute !== state.minute) shields = shieldRegions(next.cells, next.minute);
      const before = state;
      state = next; tool = selected; shape = selectedShape;
      if (local !== undefined && before && !reduced.matches) {
        const now = performance.now(), mine = new Set(local);
        const arrivals = changed.filter(i => !mine.has(i) && (before.cells[i].owner !== next.cells[i].owner || before.cells[i].shieldUntil !== next.cells[i].shieldUntil));
        if (arrivals.length) {
          // A batch starts where the previous one ends, but never more than half a second from now, so the picture stays current.
          const schedule = scheduleReveal(arrivals, Math.min(Math.max(now, revealEnd), now + 500), { stepMs: 10 });
          for (const [i, at] of schedule) { revealEnd = Math.max(revealEnd, at); if (at > now) hidden.set(i, { prev: hidden.get(i)?.prev ?? before.cells[i], at }); }
        }
      }
      const burst = local ?? changed;
      if (burst.length && !reduced.matches) {
        if (tool === 'bomb' && cursor) ripples = [...ripples, { x: cursor.x + .5, y: cursor.y + .5, born: performance.now(), color: teamColor(state.team) }].slice(-6);
        const centers = burst.length > 20 ? burst.filter((_, i) => i % 3 === 0) : burst;
        for (const i of centers) for (let j = 0; j < 10; j++) particles.push({
          x: i % SIZE + .5, y: Math.floor(i / SIZE) + .5, vx: (Math.random() - .5) * 6,
          vy: (Math.random() - .5) * 6, born: performance.now(), size: .15 + Math.random() * .3, color: tool === 'shield' ? '#38b9f4' : teamColor(state.team),
        });
        particles = particles.slice(-300);
      }
      notify();
    },
  };
}
