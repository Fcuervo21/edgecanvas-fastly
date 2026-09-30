export type Tool = 'brush' | 'bomb' | 'shield';
export type BrushShape = 'pixel' | 'circle' | 'star' | 'heart';
export interface Point { x: number; y: number }
export type Item = Exclude<Tool, 'brush'>;
export interface Player {
  id: string; name: string; team: string; totalSteps: number; dailyGoal: number;
  days: Record<string, number | null>;
}
export interface Dataset { dates: string[]; players: Player[] }
export interface Cell { owner: string | null; shieldUntil: number }
export interface GameState {
  competitive?: boolean;
  version: 1; playerId: string; team: string; cells: Cell[];
  balance: number; earned: number; spent: number; inventory: Record<Item, number>;
  minute: number; lastCreditedDay: number; messages: string[];
}
export type Command = { type: 'advance'; toMinute: number }
  | { type: 'buy'; item: Item }
  | { type: 'apply'; tool: Tool; x: number; y: number; shape?: BrushShape }
  | { type: 'stroke'; points: Point[] };
export type Code = 'OK' | 'INSUFFICIENT_PAINT' | 'OUT_OF_BOUNDS' | 'NO_CHANGE' | 'NO_ITEM' | 'INVALID_TIME' | 'NO_MORE_DAYS';
export interface Result { state: GameState; code: Code; changed: number[] }
