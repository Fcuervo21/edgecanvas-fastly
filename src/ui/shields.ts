import { SIZE } from '../game/rules';
import type { Cell } from '../game/types';

// Group visible protection only; this never changes ownership or shield duration.
export function shieldRegions(cells: Cell[], minute: number): { cells: number[]; anchor: number }[] {
  const remaining = new Set(cells.flatMap((cell, i) => cell.owner && cell.shieldUntil > minute ? [i] : []));
  const regions: { cells: number[]; anchor: number }[] = [];
  while (remaining.size) {
    const first = remaining.values().next().value!;
    const region = [first]; remaining.delete(first);
    for (let n = 0; n < region.length; n++) {
      const i = region[n], x = i % SIZE;
      const neighbors = [i - SIZE, i + SIZE, ...(x > 0 ? [i - 1] : []), ...(x < SIZE - 1 ? [i + 1] : [])];
      for (const neighbor of neighbors) if (remaining.has(neighbor) && cells[neighbor].owner === cells[first].owner) {
        remaining.delete(neighbor); region.push(neighbor);
      }
    }
    const x = region.reduce((sum, i) => sum + i % SIZE, 0) / region.length;
    const y = region.reduce((sum, i) => sum + Math.floor(i / SIZE), 0) / region.length;
    const distance = (i: number) => (i % SIZE - x) ** 2 + (Math.floor(i / SIZE) - y) ** 2;
    const anchor = region.reduce((best, i) => distance(i) < distance(best) ? i : best, first);
    regions.push({ cells: region, anchor });
  }
  return regions;
}

export function drawShieldBadge(ctx: CanvasRenderingContext2D, x: number, y: number, size: number) {
  ctx.save(); ctx.translate(x, y); ctx.scale(size / 24, size / 24);
  ctx.beginPath();
  ctx.moveTo(0, -11); ctx.lineTo(9, -7); ctx.lineTo(8, 3);
  ctx.quadraticCurveTo(7, 8, 0, 12); ctx.quadraticCurveTo(-7, 8, -8, 3);
  ctx.lineTo(-9, -7); ctx.closePath();
  ctx.lineJoin = 'round'; ctx.lineWidth = 4; ctx.strokeStyle = '#ffffff'; ctx.stroke();
  ctx.fillStyle = '#2463db'; ctx.fill();
  ctx.lineWidth = 1.5; ctx.strokeStyle = '#163b96'; ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, -8); ctx.lineTo(-6, -5); ctx.lineTo(-5, 2); ctx.quadraticCurveTo(-4, 5, 0, 8); ctx.closePath();
  ctx.fillStyle = '#58c8ff'; ctx.fill();
  ctx.beginPath(); ctx.moveTo(-4, 0); ctx.lineTo(-1, 3); ctx.lineTo(5, -3);
  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2.3; ctx.lineCap = 'round'; ctx.stroke();
  ctx.restore();
}
