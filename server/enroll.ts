import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseSteps } from '../src/data/steps';
import { createRoomService } from './service';

const args = process.argv.slice(2);
if (!args.length || args.includes('--help')) {
  console.log('Usage: npm run account:enroll -- --player "EXACT_ROSTER_PLAYER_ID" [--organizer]\nCreates a private enrollment file in .local/ with a one-time code valid for 24 hours. Verify the recipient before delivering the code privately. Reissuing revokes earlier unused codes.');
} else {
  const valid = args[0] === '--player' && args[1] && (args.length === 2 || args.length === 3 && args[2] === '--organizer');
  if (!valid) throw new Error('Invalid options. Use --help.');
  const root = resolve(import.meta.dirname, '..');
  const csv = readdirSync(resolve(root, 'StepsData')).find(name => name.endsWith('.csv'));
  if (!csv) throw new Error('The roster is missing.');
  const service = createRoomService({ dataset: parseSteps(readFileSync(resolve(root, 'StepsData', csv), 'utf8')), accessMode: 'accounts', databasePath: resolve(root, '.local/accounts-rooms.sqlite') });
  try {
    const enrollment = service.accounts!.enroll(args[1], args.includes('--organizer'));
    const file = resolve(root, '.local', `enrollment-${randomUUID()}.json`);
    writeFileSync(file, JSON.stringify(enrollment, null, 2), { mode: 0o600, flag: 'wx' });
    console.log(`Private enrollment saved to ${file}`);
  } finally { service.close(); }
}
