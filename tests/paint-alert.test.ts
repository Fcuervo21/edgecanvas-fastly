import { expect, test } from 'vitest';
import { COST } from '../src/game/rules';
import { paintAlert } from '../src/ui/paint-alert';

const room = { shared: true, finished: false };

test('no alert while at least one pixel is affordable', () => {
  expect(paintAlert(COST.brush, room)).toBeNull();
  expect(paintAlert(5000, room)).toBeNull();
});

test('an empty wallet, or one below the brush price, is told to wait for the next day', () => {
  for (const balance of [0, COST.brush - 1]) {
    const alert = paintAlert(balance, room)!;
    expect(alert.title).toMatch(/used up your paint for today/i);
    expect(alert.body).toMatch(/next day/i);
  }
});

test('in a room the wait is for the shared day; solo play can advance it itself', () => {
  expect(paintAlert(0, room)!.body).toMatch(/host/i);
  expect(paintAlert(0, { shared: false, finished: false })!.body).toMatch(/advance/i);
});

test('after the last recorded day the invitation is to keep walking, not to wait', () => {
  const alert = paintAlert(0, { shared: true, finished: true })!;
  expect(alert.title).toMatch(/keep walking/i);
  expect(alert.body).not.toMatch(/next day/i);
});
