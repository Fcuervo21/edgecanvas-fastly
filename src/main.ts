import csv from '../StepsData/sample_step_data.csv?raw';
import { parseSteps } from './data/steps';
import { createGame } from './game/engine';
import { PLAYER_ID } from './game/solo-player';
import { loadSession, saveSession } from './storage/session';
import { mountGame } from './ui/game';
import './ui/styles.css';

const root = document.querySelector<HTMLDivElement>('#app')!;
if (new URLSearchParams(window.location?.search ?? '').get('mode') === 'rooms') {
  void import('./ui/rooms').then(({ mountRooms }) => mountRooms(root));
} else try {
  const dataset = parseSteps(csv);
  let storage: Storage | undefined;
  try { storage = window.localStorage; } catch { /* The session remains usable in memory. */ }
  const loaded = storage ? loadSession(storage, dataset) : { kind: 'unavailable' as const };
  const start = () => {
    const state = loaded.kind === 'valid' ? loaded.state : createGame(dataset, PLAYER_ID);
    // If reading failed, keep this visit temporary rather than overwrite unknown progress.
    const save = (next: typeof state) => storage && loaded.kind !== 'unavailable' ? saveSession(storage, next) : false;
    mountGame(root, dataset, state, save, save(state), undefined, () => createGame(dataset, PLAYER_ID));
  };
  if (loaded.kind === 'invalid') {
    root.innerHTML = '<main class="recovery"><span class="eyebrow">EDGECANVAS</span><h1>Your canvas needs a fresh start.</h1><p>The saved game is incompatible or damaged. Your step history is still intact.</p><button class="primary" id="restart">Clear this game and start over</button></main>';
    document.querySelector('#restart')!.addEventListener('click', start, { once: true });
  } else start();
} catch (error) {
  root.innerHTML = '<main class="recovery"><span class="eyebrow">EDGECANVAS</span><h1>We could not open the step history.</h1><p id="error"></p></main>';
  document.querySelector('#error')!.textContent = error instanceof Error ? error.message : 'Error loading data.';
}
