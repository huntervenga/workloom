/** Undo sends a new inverse command with the confirmed heads; it never rewinds history. */
export type UndoHeads = Record<string, number>;
export interface UndoEntry {
  id: string;
  receipt?: string;
  scope: string;
  kind: 'edit' | 'archive' | 'create' | 'unsupported';
  heads: UndoHeads;
  beforeHeads: UndoHeads;
  /** Built once per attempt so an unknown outcome retries identical body and receipt key. */
  prepare?: (heads: Readonly<UndoHeads>, key: string) => () => Promise<UndoHeads>;
  clearFirstFill?: boolean;
}
export type UndoNotice = 'available' | 'pending' | 'unknown' | 'blocked' | 'unsupported' | 'done' | 'cleared';
export interface UndoSnapshot { count: number; notice: UndoNotice | null; critical: boolean; version: number }
export class UndoStore {
  private scope: string | null = null;
  private writable = false;
  private entries: UndoEntry[] = [];
  private notice: UndoNotice | null = null;
  private listeners = new Set<() => void>();
  private snapshot: UndoSnapshot = { count: 0, notice: null, critical: false, version: 0 };
  private held: { entry: UndoEntry; execute: () => Promise<UndoHeads> } | null = null;
  private pending = false;
  private seen = new Set<string>();
  private receipts = new Set<string>();
  constructor(private readonly options: {
    blocked: () => boolean;
    protect: (active: boolean) => void;
    uncertain: (error: unknown) => boolean;
    key: () => string;
  }) {}
  activate(scope: string | null, writable: boolean) {
    if (this.scope !== scope) {
      this.scope = scope; this.entries = []; this.seen.clear(); this.receipts.clear();
      // A sent inverse survives navigation and remains protected until its exact receipt settles.
      this.notice = this.pending ? 'pending' : this.held ? 'unknown' : null;
    }
    this.writable = writable; this.emit();
  }
  setWritable(writable: boolean) { this.writable = writable; this.emit(); }
  record(entry: UndoEntry) {
    if (entry.scope !== this.scope || this.seen.has(entry.id)) return;
    this.seen.add(entry.id);
    if (entry.receipt) this.receipts.add(entry.receipt);
    this.entries.push(entry);
    if (this.entries.length > 100) this.entries.shift();
    this.notice = this.pending ? 'pending' : this.held ? 'unknown' : entry.kind === 'archive' ? 'available' : null; this.emit();
  }
  /** Unhandled acknowledged writes are a boundary; Ctrl+Z must never jump over them. */
  acknowledge(receipt: string, workspaceId: string, actorId: string | null, observerFailed = false) {
    if (!actorId || !this.scope || this.scope.split('/')[0] !== actorId.toLowerCase() || this.scope.split('/')[1] !== workspaceId.toLowerCase() || !observerFailed && this.receipts.has(receipt)) return;
    this.record({ id: `unsupported:${receipt}${observerFailed ? ":observer-failed" : ""}`, receipt, scope: this.scope, kind: 'unsupported', heads: {}, beforeHeads: {} });
  }
  dismiss = () => { if (!this.pending && !this.held) { this.notice = null; this.emit(); } };
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  get hasOutstanding(): boolean { return this.held !== null || this.pending; }
  async undo(): Promise<void> {
    const entry = this.held?.entry ?? this.entries.at(-1);
    if (!this.writable || !entry || this.pending) return;
    if (entry.scope !== this.scope || this.options.blocked()) { this.notice = 'blocked'; this.emit(); return; }
    if (!entry.prepare) { this.notice = 'unsupported'; this.emit(); return; }
    let held = this.held;
    try { held ??= { entry, execute: entry.prepare({ ...entry.heads }, this.options.key()) }; }
    catch { this.notice = 'blocked'; this.emit(); return; }
    this.held = held; this.pending = true; this.options.protect(true); this.notice = 'pending'; this.emit();
    try {
      const confirmed = await held.execute();
      if (this.held !== held) return;
      const index = this.entries.indexOf(entry);
      if (index >= 0) this.entries.splice(index, 1);
      // Only our successful inverse may advance a prior guard from the exact before head.
      // Refetches, a colleague's newer head and a conflict never rebase an undo.
      for (const previous of index < 0 ? [] : this.entries.slice(0, index)) for (const [source, head] of Object.entries(confirmed)) {
        if (previous.heads[source] !== undefined && previous.heads[source] === entry.beforeHeads[source]) previous.heads[source] = head;
      }
      this.held = null;
      this.notice = entry.clearFirstFill ? 'cleared' : 'done';
    } catch (error) {
      if (this.held !== held) return;
      if (this.options.uncertain(error)) this.notice = 'unknown';
      else { this.held = null; this.notice = 'blocked'; }
    } finally {
      if (this.held === held || this.held === null) {
        this.pending = false; this.options.protect(this.held !== null); this.emit();
      }
    }
  }
  private emit() {
    this.snapshot = { count: this.entries.length + (this.held && !this.entries.includes(this.held.entry) ? 1 : 0), notice: this.notice, critical: this.entries.at(-1)?.kind === 'archive', version: this.snapshot.version + 1 };
    for (const listener of this.listeners) listener();
  }
}

export function isNativeUndoTarget(target: EventTarget | null): boolean {
  // Saved task-value checkboxes have no native text history; settings checkboxes stay unchanged.
  if (target instanceof Element && target.matches('input[type="checkbox"][data-project-undo="true"]')) return false;
  return target instanceof Element && !!target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]');
}
