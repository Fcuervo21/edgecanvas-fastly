import { expect, test, vi } from 'vitest';
import { codeFromLocation, describeCode } from '../src/ui/personal-link';
import { WORDS, passphrase } from '../src/ui/passphrase';

const CODE = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';

test('the code is read from the link fragment (never sent to the server) or the query', () => {
  expect(codeFromLocation({ hash: `#code=${CODE}`, search: '' })).toBe(CODE);
  expect(codeFromLocation({ hash: '', search: `?code=${CODE}` })).toBe(CODE);
  expect(codeFromLocation({ hash: `#code=${CODE}`, search: '?welcome' })).toBe(CODE);
  expect(codeFromLocation({ hash: '#code=too-short', search: '' })).toBeNull();
  expect(codeFromLocation({ hash: '', search: '' })).toBeNull();
  expect(codeFromLocation({ hash: '#code=' + 'x'.repeat(200), search: '' })).toBeNull();
});

test('a valid code greets its owner and proposes a username; a refused code gives nothing', async () => {
  const ok = vi.fn(async () => new Response(JSON.stringify({ name: 'Marta Núñez Ortega', team: 'Amber' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  expect(await describeCode(CODE, ok as unknown as typeof fetch)).toEqual({ name: 'Marta Núñez Ortega', team: 'Amber', username: 'marta.nunez' });
  const [url, init] = ok.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('/api/auth/enrollment');
  expect(JSON.parse(String(init.body))).toEqual({ code: CODE });
  const refused = vi.fn(async () => new Response(JSON.stringify({ error: 'Unable to register with these details.' }), { status: 400, headers: { 'Content-Type': 'application/json' } }));
  expect(await describeCode(CODE, refused as unknown as typeof fetch)).toBeNull();
  expect(await describeCode(CODE, vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch)).toBeNull();
});

test('suggested passwords are long, readable and different every time', () => {
  expect(new Set(WORDS).size).toBe(256);
  expect(WORDS.every(word => /^[a-z]{3,7}$/.test(word))).toBe(true);
  const phrases = new Set(Array.from({ length: 40 }, () => passphrase()));
  expect(phrases.size).toBe(40);
  for (const phrase of phrases) expect(phrase).toMatch(/^[a-z]+(-[a-z]+){4}-\d\d$/);
  expect([...phrases][0].length).toBeGreaterThanOrEqual(15);
});
