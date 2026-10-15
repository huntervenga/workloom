// Fails when browser-delivered code reaches Node.js or server code.
// apps/web and packages/ui run in the browser; packages/contracts is bundled into it.
// Checks static, dynamic and require() imports (TypeScript's preprocessor ignores comments)
// plus package.json dependencies. Complements the no-restricted-imports rule in eslint.config.mjs.
import { builtinModules } from 'node:module';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const BROWSER_PACKAGES = ['apps/web', 'packages/ui', 'packages/contracts'];
const SERVER_WORKSPACES = ['@workloom/api', '@workloom/worker', '@workloom/db', '@workloom/domain'];
const SERVER_LIBRARIES = ['fastify', 'drizzle-orm', 'drizzle-kit', 'pg', 'postgres', 'pg-boss', 'dotenv'];
const SERVER_DIRS = ['apps/api', 'apps/worker', 'packages/db', 'packages/domain'].map((dir) => join(root, dir));
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'coverage']);

const nodeBuiltins = new Set(builtinModules.map((name) => name.replace(/^node:/, '')));

function packageNameOf(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function violationFor(specifier, importer) {
  if (specifier.startsWith('node:')) return 'Node.js built-in';
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    const target = resolve(dirname(importer), specifier);
    const serverDir = SERVER_DIRS.find((dir) => target === dir || target.startsWith(dir + sep));
    return serverDir ? `server code in ${relative(root, serverDir)}` : null;
  }
  const packageName = packageNameOf(specifier);
  if (nodeBuiltins.has(packageName)) return 'Node.js built-in';
  if (SERVER_WORKSPACES.includes(packageName)) return 'server workspace';
  if (SERVER_LIBRARIES.includes(packageName)) return 'server-only library';
  return null;
}

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (SOURCE_FILE.test(entry.name)) yield path;
  }
}

const violations = [];
let checkedFiles = 0;

for (const packageDir of BROWSER_PACKAGES) {
  const srcDir = join(root, packageDir, 'src');
  if (existsSync(srcDir)) {
    for (const file of sourceFiles(srcDir)) {
      checkedFiles += 1;
      const { importedFiles } = ts.preProcessFile(readFileSync(file, 'utf8'), true, true);
      for (const { fileName: specifier } of importedFiles) {
        const reason = violationFor(specifier, file);
        if (reason) violations.push(`${relative(root, file)}: imports "${specifier}" (${reason})`);
      }
    }
  }

  const manifestPath = join(root, packageDir, 'package.json');
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const dependency of Object.keys(manifest[field] ?? {})) {
      // Dev tooling (e.g. vite.config.ts) may use server-side libraries; workspaces never.
      const forbidden =
        SERVER_WORKSPACES.includes(dependency) ||
        (field !== 'devDependencies' && SERVER_LIBRARIES.includes(dependency));
      if (forbidden) violations.push(`${packageDir}/package.json: ${field} lists "${dependency}"`);
    }
  }
}

if (violations.length > 0) {
  console.error('Browser boundary violations:');
  for (const violation of violations) console.error(`  ${violation}`);
  console.error('apps/web, packages/ui and packages/contracts must not depend on Node.js built-ins or api/worker/db/domain code.');
  process.exit(1);
}

console.log(`check:boundaries: ${checkedFiles} browser source file(s) checked, no violations.`);
