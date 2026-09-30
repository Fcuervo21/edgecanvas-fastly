/** Proposes a username from a roster name: "Pat Example Smith" becomes "pat.example". Always matches the account rules. */
export function suggestUsername(name: string): string {
  const words = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .split(/\s+/).map(word => word.replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '')).filter(Boolean);
  let suggestion = words.slice(0, 2).join('.').slice(0, 32);
  if (suggestion.length < 3) suggestion = `${suggestion || 'player'}-player`.slice(0, 32);
  return suggestion.replace(/^[^a-z0-9]+/, '') || 'player';
}
