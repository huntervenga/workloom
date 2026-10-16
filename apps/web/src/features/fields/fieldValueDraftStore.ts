import type { TaskFieldValueDto } from '@workloom/contracts';
import { isSessionDirty, type FieldEditSession } from './FieldValueForm';

export type FieldValueSessions = Partial<Record<string, FieldEditSession>>;
/** Kept compatible with existing page/drawer .current Map consumers. */
export type FieldValueDraftStore = Map<string, FieldValueSessions>;
const emptySessions: FieldValueSessions = {};
const adapters = new WeakMap<FieldValueDraftStore, ObservableFieldValueDraftStore>();

/** One page's retained input; values are never parsed, normalized or copied here. */
export class ObservableFieldValueDraftStore extends Map<string, FieldValueSessions> {
  private readonly listeners = new Set<() => void>();
  private readonly submitted = new Map<string, FieldEditSession>();
  private readonly confirmations = new WeakMap<TaskFieldValueDto, boolean>();
  private dirty = false;
  constructor(private readonly backing?: FieldValueDraftStore) { super(); for (const [key, value] of backing ?? []) super.set(key, value); this.refresh(); }
  override set(key: string, value: FieldValueSessions): this {
    super.set(key.toLowerCase(), value);
    this.backing?.set(key.toLowerCase(), value);
    this.refresh();
    return this;
  }
  override delete(key: string): boolean {
    const removed = super.delete(key.toLowerCase());
    this.backing?.delete(key.toLowerCase());
    if (removed) this.refresh();
    return removed;
  }
  override clear(): void { super.clear(); this.backing?.clear(); this.refresh(); }
  getTask = (taskId: string): FieldValueSessions => this.get(taskId.toLowerCase()) ?? emptySessions;
  getSnapshot = (): boolean => this.dirty;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  capture(taskId: string, session: FieldEditSession): void { this.submitted.set(this.slot(taskId, session.field.id), session); }
  /** A receipt retires only the exact original input/base, never a later replacement. */
  confirm(value: TaskFieldValueDto): boolean {
    const known = this.confirmations.get(value);
    if (known !== undefined) return known;
    const slot = this.slot(value.taskId, value.fieldId);
    const original = this.submitted.get(slot);
    this.submitted.delete(slot);
    const taskKey = value.taskId.toLowerCase();
    const fieldKey = value.fieldId.toLowerCase();
    const sessions = this.getTask(taskKey);
    const current = sessions[fieldKey];
    const cleared = original !== undefined && current !== undefined && current.identity === original.identity && current.draft === original.draft && current.field === original.field && current.value === original.value;
    this.confirmations.set(value, cleared);
    if (cleared) this.set(taskKey, Object.fromEntries(Object.entries(sessions).filter(([key]) => key !== fieldKey)));
    return cleared;
  }
  private slot(taskId: string, fieldId: string): string { return `${taskId.toLowerCase()}:${fieldId.toLowerCase()}`; }
  private refresh(): void {
    this.dirty = [...this.values()].some(sessions => Object.values(sessions).some(session => session !== undefined && isSessionDirty(session)));
    for (const listener of this.listeners) listener();
  }
}

/** Legacy standalone consumers may still pass a plain Map; all component writers use this adapter. */
export function observableFieldDrafts(store: FieldValueDraftStore): ObservableFieldValueDraftStore {
  if (store instanceof ObservableFieldValueDraftStore) return store;
  const known = adapters.get(store);
  if (known) return known;
  const adapter = new ObservableFieldValueDraftStore(store);
  adapters.set(store, adapter);
  return adapter;
}
