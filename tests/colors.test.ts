import { expect, test } from 'vitest';
import { teamColor } from '../src/rooms/colors';

const TEAMS = ['Amber Foxes', 'Basalt Bees', 'Cedar Owls', 'Ember Otters', 'Iris Ibex', 'Granite Geese', 'Fjord Falcons', 'Harbor Herons', 'Dune Runners', 'Juniper Jays'];
const SHIELD_BLUE = '#38b9f4';

// CIE Lab distance: about 2 is the smallest difference an eye notices, and under ~25 two colors are easy to confuse on a small board.
function lab(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047, y = r * 0.2126 + g * 0.7152 + b * 0.0722, z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (v: number) => v > 0.008856 ? v ** (1 / 3) : 7.787 * v + 16 / 116;
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}
const distance = (a: string, b: string) => Math.hypot(...lab(a).map((v, i) => v - lab(b)[i]) as [number, number, number]);

test('every team has its own color, and no two of them can be mistaken for each other on the board', () => {
  const colors = TEAMS.map(teamColor);
  expect(new Set(colors).size).toBe(TEAMS.length);
  for (let i = 0; i < TEAMS.length; i++) for (let j = i + 1; j < TEAMS.length; j++) {
    expect(distance(colors[i], colors[j]), `${TEAMS[i]} vs ${TEAMS[j]}`).toBeGreaterThanOrEqual(30);
  }
});

test('no team color can be mistaken for the blue of a shield', () => {
  for (const team of TEAMS) expect(distance(teamColor(team), SHIELD_BLUE), team).toBeGreaterThanOrEqual(25);
});
