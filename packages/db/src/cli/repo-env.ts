import { fileURLToPath } from 'node:url';

import { loadEnvFileIfPresent } from '../env-guard.js';

/** Repository-root `.env` (packages/db/{src,dist}/cli → repo root). Existing variables win. */
export function loadRepositoryEnv(): void {
  loadEnvFileIfPresent(fileURLToPath(new URL('../../../../.env', import.meta.url)));
}

export function printFailure(command: string, lines: readonly string[]): void {
  process.stderr.write(`${command} failed:\n${lines.map((line) => `  ${line}`).join('\n')}\n`);
}
