// Keep activity from the first Spanish prototype readable without resetting the game.
export function translateLegacyMessage(message: string): string {
  return message
    .replace(/^Día /, 'Day ')
    .replace('sin registro', 'no record')
    .replace(' · repetición del historial', ' · history replay')
    .replace(' de pintura', ' paint')
    .replace(/^Escudo activo en (\d+) casillas · 2 h simuladas\.$/, 'Shield active on $1 pixels · 2 simulated hours.')
    .replace(/^Bomba /, 'Bomb ')
    .replace(/^Escudo /, 'Shield ')
    .replace(/^Brochazo /, 'Brush ')
    .replace(' comprado ·', ' purchased ·')
    .replace('casillas pintadas', 'pixels painted')
    .replace('casilla pintada', 'pixel painted');
}
