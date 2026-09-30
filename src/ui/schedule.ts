import type { AutoAdvance } from '../edge/types';

/** `offset` is `Date#getTimezoneOffset()`: minutes behind UTC (local time = UTC - offset). */
export function localTimeToUtcMinute(time: string, offset: number): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  return match ? (((Number(match[1]) * 60 + Number(match[2]) + offset) % 1440) + 1440) % 1440 : null;
}
export function utcMinuteToLocalTime(at: number, offset: number): string {
  const local = (((at - offset) % 1440) + 1440) % 1440;
  return `${String(Math.floor(local / 60)).padStart(2, '0')}:${String(local % 60).padStart(2, '0')}`;
}
/** What every player reads under the day counter. Days are manual until the host chooses a time. */
export function scheduleNote(auto: AutoAdvance | null | undefined, offset: number): string {
  return auto
    ? `Automatic days: the day changes every day at ${utcMinuteToLocalTime(auto.at, offset)} (your time), and everyone refills.`
    : 'The host moves the day by hand.';
}
