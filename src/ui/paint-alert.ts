import { COST } from '../game/rules';

export interface PaintAlert { title: string; body: string }

/**
 * The notice a player sees once their own paint cannot cover even one new pixel. Wallets are personal, so
 * this shows for that player alone; it disappears by itself when the next day refills them.
 */
export function paintAlert(balance: number, context: { shared: boolean; finished: boolean }): PaintAlert | null {
  if (balance >= COST.brush) return null;
  if (context.finished) return { title: 'Keep walking!', body: 'You have used all the paint from the recorded steps. More arrives with the next steps update.' };
  return {
    title: 'You have used up your paint for today.',
    body: context.shared
      ? 'Wait for the next day: the host moves the shared clock and your paint refills from your steps.'
      : 'Advance to the next day to refill from your steps.',
  };
}
