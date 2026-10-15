// Runs one npm script in every Workloom workspace that defines it, in dependency order.
// Usage: node scripts/run-workspaces.mjs <script> [--libs]
//   --libs  only library packages (what apps and tests import from dist).
// Workspaces that do not exist yet or lack the script are skipped and reported;
// the command fails if nothing ran, so a missing implementation never looks green.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const LIBRARY_ORDER = ['@workloom/contracts', '@workloom/domain', '@workloom/db', '@workloom/ui'];
const APP_ORDER = ['@workloom/api', '@workloom/web'];
// Holds shared tsconfig files only; nothing to build or check.
const TOOLING_ONLY = new Set(['@workloom/config']);

const [script, ...flags] = process.argv.slice(2);
if (!script) {
  console.error('usage: node scripts/run-workspaces.mjs <script> [--libs]');
  process.exit(2);
}
const librariesOnly = flags.includes('--libs');

/** @returns {Map<string, { group: string, scripts: Record<string, string> }>} */
function discoverWorkspaces() {
  const found = new Map();
  for (const group of ['packages', 'apps']) {
    const groupDir = join(root, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      const manifestPath = join(groupDir, entry.name, 'package.json');
      if (!entry.isDirectory() || !existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (typeof manifest.name !== 'string' || TOOLING_ONLY.has(manifest.name)) continue;
      found.set(manifest.name, { group, scripts: manifest.scripts ?? {} });
    }
  }
  return found;
}

function runNpm(args) {
  // Reuse the npm that launched us when possible; fall back to PATH.
  const npmCli = process.env.npm_execpath;
  const result =
    npmCli && npmCli.endsWith('.js')
      ? spawnSync(process.execPath, [npmCli, ...args], { cwd: root, stdio: 'inherit' })
      : spawnSync('npm', args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

const workspaces = discoverWorkspaces();
const knownOrder = librariesOnly ? LIBRARY_ORDER : [...LIBRARY_ORDER, ...APP_ORDER];
// Workspaces added later (e.g. apps/worker in P3) run after the known ones.
const extras = [...workspaces.keys()]
  .filter((name) => !knownOrder.includes(name))
  .filter((name) => !librariesOnly || workspaces.get(name)?.group === 'packages')
  .sort();

let ran = 0;
for (const name of [...knownOrder, ...extras]) {
  const workspace = workspaces.get(name);
  if (!workspace) {
    console.log(`[run-workspaces] ${name}: not present yet, skipped`);
    continue;
  }
  if (!workspace.scripts[script]) {
    console.log(`[run-workspaces] ${name}: no "${script}" script, skipped`);
    continue;
  }
  console.log(`[run-workspaces] ${name}: npm run ${script}`);
  const status = runNpm(['run', script, '--workspace', name]);
  if (status !== 0) process.exit(status);
  ran += 1;
}

if (ran === 0) {
  console.error(`[run-workspaces] no ${librariesOnly ? 'library ' : ''}workspace defines "${script}"`);
  process.exit(1);
}
