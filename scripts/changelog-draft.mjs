// Lists the main commits that the What's new log does not account for yet, so their user-visible
// changes can be summed up in plain words in apps/web/src/features/changelog/changelog.json.
// Usage: npm run changelog:draft [-- <ref>]   (default ref: origin/main)
// After adding the entries, set "covers" in that file to the newest commit listed here.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = join(root, 'apps/web/src/features/changelog/changelog.json');
const { covers } = JSON.parse(readFileSync(file, 'utf8'));
const ref = process.argv[2] ?? 'origin/main';
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

const head = git('rev-parse', ref);
const lines = git('log', '--no-merges', '--date=short', '--format=%ad %h %an | %s', `${covers}..${head}`);
if (!lines) {
  console.log(`What's new covers ${ref} (${head.slice(0, 7)}): nothing to add.`);
} else {
  console.log(`Commits on ${ref} after ${covers.slice(0, 7)}, newest first. Add what users can notice to changelog.json,`);
  console.log(`grouped by day in plain words, then set "covers" to ${head}.\n`);
  console.log(lines);
}
