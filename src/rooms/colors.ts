const COLORS: Record<string, string> = {
  'Amber Foxes': '#FF282D', 'Basalt Bees': '#7C3AED', 'Cedar Owls': '#312E81',
  'Ember Otters': '#D97706', 'Iris Ibex': '#DB2777',
  'Granite Geese': '#059669', 'Fjord Falcons': '#2563EB', 'Harbor Herons': '#84CC16',
  'Dune Runners': '#7F1D1D', 'Juniper Jays': '#4D7C0F',
};
export function teamColor(team: string): string {
  if (Object.hasOwn(COLORS, team)) return COLORS[team];
  let hash = 0;
  for (const char of team) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360} 65% 42%)`;
}
