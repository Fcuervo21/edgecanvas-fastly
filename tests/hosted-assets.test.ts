import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { parseSteps } from '../src/data/steps';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
async function assets(mode: string) {
  const outDir = mkdtempSync(join(tmpdir(), 'edge-assets-')); dirs.push(outDir);
  await build({ mode, logLevel: 'silent', build: { outDir, emptyOutDir: true, sourcemap: true } });
  return readdirSync(outDir, { recursive: true }).filter(file => statSync(join(outDir, String(file))).isFile())
    .map(file => ({ name: String(file), text: readFileSync(join(outDir, String(file)), 'utf8') }));
}
const csvPath = resolve('StepsData', readdirSync('StepsData').find(file => file.endsWith('.csv'))!);

test('hosted output and source maps exclude the private dataset and local entry', async () => {
  const output = await assets('hosted');
  expect(output.some(file => file.name === 'index.html')).toBe(true);
  expect(output.some(file => file.name.endsWith('.map'))).toBe(true);
  const raw = readFileSync(csvPath, 'utf8');
  // Nobody's name or roster ID may appear in anything a visitor can download, not only the CSV rows.
  const people = parseSteps(raw).players.flatMap(player => [player.name, player.id]);
  expect(people.length).toBeGreaterThan(20);
  const forbidden = [raw, JSON.stringify(raw).slice(1, -1), 'Total Steps', 'StepsData/', '2026_step_data', 'edgecanvas.single-player.v1', ...people];
  for (const file of output) {
    // Assertions expose only filenames and booleans, never private rows.
    expect(forbidden.some(marker => file.text.includes(marker)), file.name).toBe(false);
    expect(file.name.toLowerCase().endsWith('.csv')).toBe(false);
  }
}, 30000);

test('the explicit local build preserves the original solo dataset and save boundary', async () => {
  const output = await assets('production');
  expect(output.some(file => file.text.includes('Total Steps'))).toBe(true);
  expect(output.some(file => file.text.includes('edgecanvas.single-player.v1'))).toBe(true);
}, 30000);

// Inject imports in memory so regression checks never modify source files or copy private rows.
test.each([
  ['direct CSV', () => `import privateData from ${JSON.stringify(csvPath + '?raw')}; console.log(privateData);`],
  ['server blocklist', () => `import { blockedPasswordHashes } from ${JSON.stringify(resolve('server/data/password-blocklist.ts'))}; console.log(blockedPasswordHashes);`],
  ['local entry', () => `import(${JSON.stringify(resolve('src/main.ts'))});`],
])('hosted builds reject a reintroduced %s import', async (_label, injection) => {
  await expect(build({
    mode: 'hosted', logLevel: 'silent', build: { write: false },
    plugins: [{
      name: 'test-private-import', enforce: 'pre',
      transform(code, id) {
        if (id === resolve('src/hosted.ts')) return { code: injection() + code, map: null };
      },
    }],
  })).rejects.toThrow('Private datasets cannot be imported into the hosted frontend.');
}, 30000);
