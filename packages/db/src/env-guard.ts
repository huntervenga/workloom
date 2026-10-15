import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

/**
 * Environment guards shared by the API configuration and the db CLIs. Local
 * synthetic tooling (dev identity, demo seed) must never run in a hosted
 * environment, whatever NODE_ENV says.
 */
export class UnsafeEnvironmentError extends Error {
  override readonly name = 'UnsafeEnvironmentError';
}

export type EnvironmentSource = Readonly<Record<string, string | undefined>>;

/** Names (never values) of variables that indicate a Railway environment. */
export function findRailwayMarkers(env: EnvironmentSource): string[] {
  return Object.keys(env)
    .filter((key) => key === 'RAILWAY' || key.startsWith('RAILWAY_'))
    .sort();
}

/** Throws unless APP_ENV=local and no hosted-platform marker is present. */
export function assertLocalSyntheticEnvironment(env: EnvironmentSource, purpose: string): void {
  const problems: string[] = [];
  const appEnv = env.APP_ENV?.trim();
  if (appEnv !== 'local') {
    problems.push(`APP_ENV must be "local" for ${purpose} (got ${appEnv ? `"${appEnv}"` : 'nothing'}).`);
  }
  const markers = findRailwayMarkers(env);
  if (markers.length > 0) {
    problems.push(`${purpose} refuses to run on Railway (found ${markers.join(', ')}).`);
  }
  if (problems.length > 0) {
    throw new UnsafeEnvironmentError(problems.join(' '));
  }
}

/**
 * Loads KEY=value pairs from a dotenv file if it exists. Variables already set
 * in the process environment win, matching `node --env-file` semantics.
 * Returns whether a file was read.
 */
export function loadEnvFileIfPresent(path: string, target: Record<string, string | undefined> = process.env): boolean {
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
  for (const [key, value] of Object.entries(parseEnv(content))) {
    if (target[key] === undefined && value !== undefined) {
      target[key] = value;
    }
  }
  return true;
}
