import type { Dataset } from '../../src/game/types';

/** Synthetic identities only; six complete teams and four incomplete teams. */
export function acceptanceDataset(days = 2): Dataset {
  const sizes = [3, 3, 3, 3, 3, 3, 2, 1, 1, 1];
  // Shared rooms end with the data, so a test that advances many days needs that many dated columns.
  const dates = Array.from({ length: days }, (_, i) => new Date(Date.UTC(2026, 6, 1 + i)).toISOString().slice(0, 10));
  return {
    dates,
    players: sizes.flatMap((size, team) => Array.from({ length: size }, (_, member) => ({
      id: `team-${team}:player-${member}`, name: `Player ${team}-${member}`,
      team: `team-${team}`, totalSteps: 20000 * days, dailyGoal: 5000,
      days: Object.fromEntries(dates.map(date => [date, 20000])),
    }))),
  };
}
