import { expect, test } from 'vitest';
import { issueInkTicket, readInkTicket } from '../src/edge/ink-ticket';

const claims = { room: 'ABC123ABC123', player: 'Team Ñ:Ana Sánchez', team: 'Team Ñ', exp: 5_000_000 };

test('a ticket carries who may preview and for how long, and only this service can make one', async () => {
  const ticket = await issueInkTicket('pepper', claims);
  expect(ticket).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  expect(await readInkTicket('pepper', ticket, 4_999_999)).toEqual(claims);
  expect(await readInkTicket('pepper', ticket, 5_000_000)).toBeNull();          // expired
  expect(await readInkTicket('another pepper', ticket, 1)).toBeNull();          // not ours
});

test('a changed, truncated or malformed ticket is refused', async () => {
  const [payload, mac] = (await issueInkTicket('pepper', claims)).split('.');
  const forged = btoa(JSON.stringify(['ABC123ABC123', 'Team Ñ:Someone Else', 'Other', 9e9])).replace(/=+$/, '');
  for (const bad of [`${forged}.${mac}`, `${payload}.${mac.slice(1)}`, payload, `${payload}.`, '.', '', 'a.b.c', `${payload}.${mac}x`]) expect(await readInkTicket('pepper', bad, 1)).toBeNull();
  expect(await readInkTicket('pepper', undefined as never, 1)).toBeNull();
});
