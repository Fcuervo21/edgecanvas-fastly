import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

// Public security corpus only; never run this on user passwords or the private CSV.
const sourceSha256 = 'c2e5696882c603b76bb67a47ee970897e5a76fc4c3f5547abe3d0ca340c576e0';
if (process.argv.length !== 3) throw new Error('Supply the pinned SecLists NCSC source file.');
const source = readFileSync(process.argv[2]);
if (createHash('sha256').update(source).digest('hex') !== sourceSha256) throw new Error('Unexpected blocklist source checksum. Review a source update before rebuilding.');
const lines = new TextDecoder('utf-8', { fatal: true }).decode(source).split(/\r?\n/).filter(line => line.length > 0);
// Shorter choices already fail the 15-character minimum. Lowercase only for screening;
// authentication still hashes the exact password, preserving case and whitespace.
const hashes = [...new Set(lines.map(line => line.toLowerCase()).filter(line => [...line].length >= 15)
  .map(line => createHash('sha256').update(line, 'utf8').digest('hex')))].sort();
const output = `// Generated from the pinned public SecLists/NCSC corpus; see README.md and LICENSE.\n// Source SHA-256: ${sourceSha256}\nexport const blockedPasswordHashes = [\n${hashes.map(hash => `  '${hash}',`).join('\n')}\n] as const;\n`;
writeFileSync(resolve(import.meta.dirname, 'data/password-blocklist.ts'), output);
console.log(`Generated ${hashes.length} screening hashes from ${lines.length} public source entries.`);
