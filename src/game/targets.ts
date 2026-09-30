import { COST, SIZE } from './rules';
import type { BrushShape, GameState, Tool } from './types';

export const BRUSH_MASKS: Record<BrushShape, string[]> = {
  pixel: ['1'],
  circle: ['01110', '11111', '11111', '11111', '01110'],
  star: ['0001000', '0001000', '1111111', '0111110', '0011100', '0110110', '0100010'],
  heart: ['01010', '11111', '11111', '01110', '00100'],
};

export function validPoint(x: number, y: number): boolean {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < SIZE && y < SIZE;
}
export function paintable(state: GameState, index: number): boolean {
  const cell = state.cells[index];
  return cell.owner === null || !!state.competitive && cell.owner !== state.team && cell.shieldUntil <= state.minute;
}
export function paintCost(state: GameState, indices: number[]): number {
  return [...new Set(indices)].reduce((sum, index) => {
    const cell = state.cells[index];
    if (!cell || !paintable(state, index)) return sum;
    return sum + (cell.owner === null ? COST.brush : COST.rival);
  }, 0);
}
export function previewTargets(state: GameState, tool: Tool, x: number, y: number, shape: BrushShape = 'pixel'): number[] {
  if (!validPoint(x, y)) return [];
  const mask = BRUSH_MASKS[shape];
  const radius = tool === 'bomb' ? 2 : tool === 'shield' ? 1 : Math.floor(mask.length / 2);
  const indices: number[] = [];
  for (let row = Math.max(0, y - radius); row <= Math.min(SIZE - 1, y + radius); row++) {
    for (let col = Math.max(0, x - radius); col <= Math.min(SIZE - 1, x + radius); col++) {
      if (tool === 'brush' && mask[row - y + radius][col - x + radius] !== '1') continue;
      const index = row * SIZE + col;
      const cell = state.cells[index];
      if (tool === 'shield' ? cell.owner === state.team && cell.shieldUntil <= state.minute : paintable(state, index)) indices.push(index);
    }
  }
  return indices;
}
