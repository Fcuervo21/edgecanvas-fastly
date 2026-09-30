import { champion, pixelCounts, ranking, tally, type DayResult } from '../game/standings';
import type { Cell } from '../game/types';
import { teamColor } from '../rooms/colors';

export interface ScoreRow { rank: number; team: string; color: string; pixels: number; share: number; wins: number; joined: number; total: number; mine: boolean }
export interface Scoreboard {
  rows: ScoreRow[];
  /** Who holds the most pixels right now (`tied` when two teams are level at the top). */
  leader: { team: string; pixels: number; tied: boolean } | null;
  /** How the most recent closed day ended. */
  lastDay: DayResult | null;
  /** Most days won; on the last day `final` says the result stands as if the day ended now. */
  champion: { team: string; wins: number; final: boolean } | null;
}

/** Everything the scoreboard shows, worked out from the room's public data (`days` is absent in rooms that do not record results). */
export function scoreboard(input: { members: { team: string; color: string; joined: boolean }[]; cells: readonly Cell[]; days: readonly DayResult[] | undefined; team: string; lastDay: boolean }): Scoreboard {
  const counts = pixelCounts(input.cells);
  const teams = [...new Set(input.members.map(m => m.team))];
  const ranked = ranking(counts, teams), top = ranked[0]?.pixels ?? 0;
  const wins = input.days ? tally(input.days, counts, input.lastDay) : new Map<string, number>();
  const rows = ranked.map(({ team, pixels }, i): ScoreRow => {
    const people = input.members.filter(m => m.team === team);
    return { rank: i + 1, team, color: teamColor(team), pixels, share: top ? pixels / top : 0, wins: wins.get(team) ?? 0,
      joined: people.filter(m => m.joined).length, total: people.length, mine: team === input.team };
  });
  const won = input.days ? champion(input.days, counts, input.lastDay) : null;
  return {
    rows,
    leader: ranked[0] && ranked[0].pixels > 0 ? { ...ranked[0], tied: ranked[1]?.pixels === ranked[0].pixels } : null,
    lastDay: input.days?.at(-1) ?? null,
    champion: won ? { ...won, final: input.lastDay } : null,
  };
}
