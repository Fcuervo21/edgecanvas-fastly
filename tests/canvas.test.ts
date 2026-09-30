import { expect, test } from 'vitest';
import { pointToCell } from '../src/ui/canvas';
test('maps CSS coordinates independently of screen density', () => {
  const rect = { left: 50, top: 20, width: 500, height: 500 };
  expect(pointToCell(300, 270, rect)).toEqual({ x: 50, y: 50 });
  expect(pointToCell(550, 270, rect)).toBeNull();
  expect(pointToCell(49, 20, rect)).toBeNull();
  expect(pointToCell(0, 0, { left: 0, top: 0, width: 0, height: 0 })).toBeNull();
  expect(pointToCell(NaN, 0, rect)).toBeNull();
});
