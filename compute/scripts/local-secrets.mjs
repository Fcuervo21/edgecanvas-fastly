// Creates random local-only secrets for Viceroy in .secrets/ (git-ignored). Hosted secrets are
// created in the Fastly Secret Store during an authorized deployment, never from these files.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = resolve(import.meta.dirname, '../.secrets');
mkdirSync(dir, { recursive: true, mode: 0o700 });
for (const name of ['admin_token', 'password_pepper', 'local_grip_key']) {
  const file = resolve(dir, name);
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString('base64url'), { mode: 0o600 });
}
console.log(`Local secrets are in ${dir}`);
