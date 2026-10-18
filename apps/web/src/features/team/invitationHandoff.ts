/** Invitation credentials exist only in this module's memory, never in router/cache/storage state. */
export interface InvitationCredential { readonly invitationId: string; readonly secret: string }
export type InvitationHandoffState = 'empty' | 'ready' | 'invalid' | 'sign-in-first' | 'expired';
/** React Router matches route names case-insensitively and tolerates trailing slashes. */
export function isJoinInvitationPath(pathname: string): boolean {
  try {
    // Match React Router's one-pass segment decoding; encoded slashes remain inside a segment.
    const decoded = pathname.split('/').map(segment => decodeURIComponent(segment).replace(/\//g, '%2F')).join('/');
    return /^\/app\/join\/*$/i.test(decoded);
  } catch { return false; }
}
const credentialPattern = /^#([a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})\.([A-Za-z0-9_-]{42}[AEIMQUYcgkosw048])$/;
let credential: InvitationCredential | null = null;
let actor: string | null = null;
let state: InvitationHandoffState = 'empty';
const listeners = new Set<() => void>();
function publish(next: InvitationHandoffState) { state = next; for (const listener of listeners) listener(); }
export const invitationHandoff = {
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  getSnapshot: (): InvitationHandoffState => state,
  /** Called synchronously before app/router loading. Ordinary URLs and Auth callbacks are untouched. */
  capture(location: Pick<Location, 'pathname' | 'search' | 'hash'>, history: Pick<History, 'state' | 'replaceState'>): void {
    if (!isJoinInvitationPath(location.pathname) || location.hash === '') return;
    const match = credentialPattern.exec(location.hash);
    // Strip even malformed invitation fragments. Never pass the fragment to shared Auth.
    history.replaceState(history.state, '', `${location.pathname}${location.search}`);
    credential = match ? Object.freeze({ invitationId: (match[1] as string).toLowerCase(), secret: match[2] as string }) : null;
    actor = null;
    publish(credential ? 'ready' : 'invalid');
  },
  /** An anonymous arrival must sign in and reopen the original link, without carrying its credential. */
  requireSignIn(): void { credential = null; actor = null; publish('sign-in-first'); },
  claim(actorId: string): void {
    if (!credential) return;
    const id = actorId.toLowerCase();
    if (actor !== null && actor !== id) { this.clear(); return; }
    actor = id;
  },
  forActor(actorId: string): InvitationCredential | null {
    return actor === actorId.toLowerCase() ? credential : null;
  },
  clear(): void { credential = null; actor = null; if (state !== 'empty') publish('expired'); },
};
