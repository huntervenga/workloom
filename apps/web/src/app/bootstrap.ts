// Decides what the entry script does before any app code loads: mount the app under /app,
// forward legacy /w links into it, or leave public pages alone.

export interface EntryLocation {
  pathname: string;
  search: string;
  hash: string;
}

export interface BootstrapLocation extends EntryLocation {
  replace(url: string): void;
}

export type AppEntry = { kind: 'app' } | { kind: 'redirect'; to: string } | { kind: 'public' };

const APP_BASE = '/app';
const LEGACY_BASE = '/w';

function isUnder(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`);
}

export function getAppEntry({ pathname, search, hash }: EntryLocation): AppEntry {
  if (isUnder(pathname, APP_BASE)) {
    return { kind: 'app' };
  }
  if (isUnder(pathname, LEGACY_BASE)) {
    // Always a path under /app on this origin; the pathname stays percent-encoded as the browser gave it.
    return { kind: 'redirect', to: `${APP_BASE}${pathname}${search}${hash}` };
  }
  return { kind: 'public' };
}

export async function runBootstrap(
  location: BootstrapLocation,
  loadApp: () => Promise<void>,
): Promise<AppEntry> {
  const entry = getAppEntry(location);
  if (entry.kind === 'app') {
    await loadApp();
  } else if (entry.kind === 'redirect') {
    location.replace(entry.to);
  }
  return entry;
}
