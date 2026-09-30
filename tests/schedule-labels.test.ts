import { expect, test } from 'vitest';
import { localTimeToUtcMinute, scheduleNote, utcMinuteToLocalTime } from '../src/ui/schedule';

// getTimezoneOffset() is minutes behind UTC: Mexico City (UTC-6) reports 360, Madrid in winter (UTC+1) reports -60.
test('a local time of day becomes the UTC minute the server stores, and back', () => {
  expect(localTimeToUtcMinute('21:00', 360)).toBe(3 * 60);        // 21:00 in UTC-6 is 03:00 UTC the next day
  expect(localTimeToUtcMinute('00:30', -60)).toBe(23 * 60 + 30);  // 00:30 in UTC+1 is 23:30 UTC the day before
  expect(localTimeToUtcMinute('12:00', 0)).toBe(720);
  expect(utcMinuteToLocalTime(3 * 60, 360)).toBe('21:00');
  expect(utcMinuteToLocalTime(23 * 60 + 30, -60)).toBe('00:30');
  for (const offset of [360, -60, 0, -330, 210]) expect(utcMinuteToLocalTime(localTimeToUtcMinute('07:45', offset)!, offset)).toBe('07:45');
});

test('malformed times are refused instead of guessed', () => {
  for (const text of ['', '25:00', '12:60', 'noon', '9:5']) expect(localTimeToUtcMinute(text, 0)).toBeNull();
});

test('everyone is told how days change: by hand, or automatically at their local time', () => {
  expect(scheduleNote(null, 360)).toMatch(/host moves the day/i);
  const note = scheduleNote({ at: 3 * 60, next: Date.UTC(2026, 9, 7, 3) }, 360);
  expect(note).toMatch(/automatic/i);
  expect(note).toContain('21:00');
});
