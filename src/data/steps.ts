import Papa from 'papaparse';
import type { Dataset, Player } from '../game/types';

function number(value: string, context: string): number {
  const text = value?.trim();
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(text ?? '')) throw new Error(`Invalid number in ${context}.`);
  const parsed = Number(text.replaceAll(',', ''));
  if (!Number.isSafeInteger(parsed)) throw new Error(`Number out of range in ${context}.`);
  return parsed;
}

export function parseSteps(csv: string): Dataset {
  // Inspect the original header before Papa can rename duplicate columns.
  const first = Papa.parse<string[]>(csv.replace(/^\uFEFF/, ''), { preview: 1 }).data[0];
  const headers = first?.map(h => h.trim()) ?? [];
  if (new Set(headers).size !== headers.length) throw new Error('Duplicate column in the CSV.');
  for (const key of ['Team Source', 'Name', 'Total Steps', 'Daily Step Goal']) {
    if (!headers.includes(key)) throw new Error(`Missing column ${key}.`);
  }
  const dates = headers.filter(h => /^\d{4}-\d{2}-\d{2}$/.test(h)).sort();
  if (!dates.length) throw new Error('No dates found in the CSV.');
  dates.forEach((date, i) => {
    const ms = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== date
      || (i > 0 && ms - Date.parse(`${dates[i - 1]}T00:00:00Z`) !== 86400000)) {
      throw new Error(`Invalid or nonconsecutive date: ${date}.`);
    }
  });
  const parsed = Papa.parse<Record<string, string>>(csv, {
    header: true, skipEmptyLines: 'greedy', dynamicTyping: false, transformHeader: h => h.trim(),
  });
  if (parsed.errors.length) throw new Error(`Invalid CSV: ${parsed.errors[0].message}`);
  const ids = new Set<string>();
  const players: Player[] = parsed.data.map((row, index) => {
    const context = `row ${index + 2}`;
    const team = row['Team Source']?.trim().replace(/\s+/g, ' ');
    const name = row.Name?.trim().replace(/\s+/g, ' ');
    if (!team || !name) throw new Error(`Missing team or name in ${context}.`);
    const id = `${team}:${name}`;
    if (ids.has(id)) throw new Error(`Duplicate participant in ${context}.`);
    ids.add(id);
    const days: Player['days'] = {};
    for (const date of dates) {
      const value = row[date]?.trim();
      days[date] = !value || value === 'N.A' ? null : number(value, `${context}, ${date}`);
    }
    const totalSteps = number(row['Total Steps'], `${context}, Total Steps`);
    const dailyGoal = number(row['Daily Step Goal'], `${context}, Daily Step Goal`);
    if (Object.values(days).reduce<number>((sum, value) => sum + (value ?? 0), 0) !== totalSteps) {
      throw new Error(`The total does not match daily steps for ${name}, ${context}.`);
    }
    return { id, name, team, totalSteps, dailyGoal, days };
  });
  if (!players.length) throw new Error('The CSV contains no participants.');
  return { dates, players };
}
