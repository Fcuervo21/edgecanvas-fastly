import type { Cell } from './types';

/** How a day ended: the team with the most pixels when it closed (`null` for a tie or an empty board). */
export interface DayResult { day: number; team: string | null; pixels: number }

export function pixelCounts(cells: readonly Cell[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const cell of cells) if (cell.owner) counts.set(cell.owner, (counts.get(cell.owner) ?? 0) + 1);
  return counts;
}
const byPixelsThenName = (a: { team: string; pixels: number }, b: { team: string; pixels: number }) => b.pixels - a.pixels || a.team.localeCompare(b.team);
/** Teams from most to fewest pixels (ties alphabetical), including `teams` that have painted nothing. */
export function ranking(counts: ReadonlyMap<string, number>, teams: readonly string[]): { team: string; pixels: number }[] {
  return [...new Set([...counts.keys(), ...teams])].map(team => ({ team, pixels: counts.get(team) ?? 0 })).sort(byPixelsThenName);
}
export function dayResult(day: number, cells: readonly Cell[]): DayResult {
  const [first, second] = ranking(pixelCounts(cells), []);
  if (!first) return { day, team: null, pixels: 0 };
  return { day, team: second && second.pixels === first.pixels ? null : first.team, pixels: first.pixels };
}
/** Days won per team; on the last day (`finalDayLive`) the team leading right now also takes that day. */
export function tally(days: readonly DayResult[], counts: ReadonlyMap<string, number>, finalDayLive: boolean): Map<string, number> {
  const wins = new Map<string, number>();
  for (const { team } of days) if (team) wins.set(team, (wins.get(team) ?? 0) + 1);
  if (finalDayLive) {
    const [first, second] = ranking(counts, []);
    if (first && first.pixels > 0 && second?.pixels !== first.pixels) wins.set(first.team, (wins.get(first.team) ?? 0) + 1);
  }
  return wins;
}
/**
 * The team that has won the most days; a tie goes to whoever holds more pixels right now. On the last day (`finalDayLive`)
 * the team leading at this moment also takes that day, so the final result is known as soon as the last day is over.
 */
export function champion(days: readonly DayResult[], counts: ReadonlyMap<string, number>, finalDayLive: boolean): { team: string; wins: number } | null {
  const table = [...tally(days, counts, finalDayLive)].map(([team, won]) => ({ team, won, pixels: counts.get(team) ?? 0 }))
    .sort((a, b) => b.won - a.won || b.pixels - a.pixels || a.team.localeCompare(b.team));
  return table[0] ? { team: table[0].team, wins: table[0].won } : null;
}
