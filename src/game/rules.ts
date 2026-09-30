export const SIZE = 100;
export const COLOR = '#FF282D';
/** Paint prices. `brush`: a new pixel; `rival`: taking an unshielded rival pixel; tools: a bomb (25 pixels) or a shield (9 pixels). */
export const COST = { brush: 10, rival: 20, bomb: 200, shield: 200 } as const;
export const SHIELD_MINUTES = 120;
