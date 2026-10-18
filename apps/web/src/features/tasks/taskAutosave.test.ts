import type { TaskDto, UpdateTaskInput } from '@workloom/contracts';
import { describe, expect, it } from 'vitest';
import { task } from '../planning/test/fixtures';
import { autosaveRetains, createTaskAutosave, type AutosaveOutcome, type AutosaveTransport } from './taskAutosave';
import type { EditSession } from './useTaskCommands';

class Outcome extends Error {
  constructor(readonly outcome: AutosaveOutcome) { super(outcome); }
}

interface Answer { resolve: (task: TaskDto) => void; reject: (error: unknown) => void }

function harness() {
  const sent: { taskId: string; input: UpdateTaskInput }[] = [];
  const resent: UpdateTaskInput[] = [];
  const answers: Answer[] = [];
  const mirror = new Map<string, EditSession>();
  const state = { allowed: true, held: null as UpdateTaskInput | null };
  const answer = () => new Promise<TaskDto>((resolve, reject) => { answers.push({ resolve, reject }); });
  const transport: AutosaveTransport = {
    send: (taskId, input) => { sent.push({ taskId, input }); return answer(); },
    resend: (_taskId, input) => { if (state.held !== input) return null; resent.push(input); return answer(); },
    canSend: () => state.allowed,
    classify: (error) => (error instanceof Outcome ? error.outcome : 'rejected'),
    retain: (taskId, session) => { if (session) mirror.set(taskId, session); else mirror.delete(taskId); },
  };
  const autosave = createTaskAutosave(transport);
  autosave.authorize(task.id, true);
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const next = () => {
    const pending = answers.shift();
    if (!pending) throw new Error('No write is waiting for an answer');
    return pending;
  };
  return { autosave, sent, resent, mirror, state, settle, next };
}

const confirmed = (patch: Partial<TaskDto>, revision: number): TaskDto => ({ ...task, ...patch, revision });

describe('saved-task autosave controller', () => {
  it('preserves a raw word separator across staging another field, then normalizes a no-op title on commit without writing', () => {
    const h = harness();
    h.autosave.stage(task, { title: `${task.title} ` });
    h.autosave.stage(task, { description: 'Still typing elsewhere' });
    expect(h.autosave.get(task.id)?.draft.title).toBe(`${task.title} `);
    h.autosave.commit(task.id, ['title']);
    expect(h.autosave.get(task.id)?.draft.title).toBe(task.title);
    expect(h.autosave.get(task.id)?.draft.description).toBe('Still typing elsewhere');
    expect(h.sent).toHaveLength(0);
  });

  it('stages typing without writing and serializes committed fields against each confirmed revision', async () => {
    const h = harness();
    h.autosave.stage(task, { title: 'D' });
    h.autosave.stage(task, { title: 'Draft title' });
    h.autosave.stage(task, { description: 'Typed but never committed' });
    expect(h.sent).toHaveLength(0);

    h.autosave.commit(task.id, ['title']);
    expect(h.sent).toEqual([{ taskId: task.id, input: { expectedRevision: 1, title: 'Draft title' } }]);
    expect(Object.isFrozen(h.sent[0]?.input)).toBe(true);

    // A choice while the first write is unanswered waits: never two writes at once.
    h.autosave.choose(task, { priority: 'high' });
    expect(h.sent).toHaveLength(1);
    expect(h.autosave.get(task.id)?.phase).toBe('saving');

    h.next().resolve(confirmed({ title: 'Draft title' }, 2));
    await h.settle();
    // Only the committed key, built on the confirmed base revision; the unsent description stays local.
    expect(h.sent[1]).toEqual({ taskId: task.id, input: { expectedRevision: 2, priority: 'high' } });
    h.next().resolve(confirmed({ title: 'Draft title', priority: 'high' }, 3));
    await h.settle();
    const entry = h.autosave.get(task.id);
    expect(entry?.base.revision).toBe(3);
    expect(entry?.draft.description).toBe('Typed but never committed');
    expect(h.sent).toHaveLength(2);
  });

  it('keeps newer text typed during an unanswered write and retains it after the answer', async () => {
    const h = harness();
    h.autosave.stage(task, { title: 'First' });
    h.autosave.commit(task.id, ['title']);
    const submitted = h.sent[0]?.input;
    h.autosave.stage(task, { title: 'Newer' });
    expect(submitted).toEqual({ expectedRevision: 1, title: 'First' });

    h.next().resolve(confirmed({ title: 'First' }, 2));
    await h.settle();
    const entry = h.autosave.get(task.id);
    expect(entry?.base.title).toBe('First');
    expect(entry?.draft.title).toBe('Newer');
    expect(autosaveRetains(entry)).toBe(true);
    // Confirming the old submission never drops the newer retained input.
    expect(h.mirror.get(task.id)?.draft.title).toBe('Newer');

    h.autosave.commit(task.id, ['title']);
    expect(h.sent[1]?.input).toEqual({ expectedRevision: 2, title: 'Newer' });
  });

  it('retains typed, queued and sending input across close/remount and releases only a clean session', async () => {
    const h = harness();
    h.autosave.stage(task, { title: 'Kept while closed' });
    expect(h.mirror.get(task.id)?.draft.title).toBe('Kept while closed');
    h.autosave.commit(task.id, ['title']);
    // A remounted pane reads the same page-owned entry.
    const reopened = h.autosave.get(task.id);
    expect(reopened?.sending?.input).toBe(h.sent[0]?.input);
    expect(h.autosave.hasRetained()).toBe(true);

    h.next().resolve(confirmed({ title: 'Kept while closed' }, 2));
    await h.settle();
    expect(h.mirror.has(task.id)).toBe(false);
    expect(h.autosave.hasRetained()).toBe(false);
    expect(h.autosave.get(task.id)?.phase).toBe('saved');
  });

  it('resends an unknown write exactly once through the held body and pauses the queue meanwhile', async () => {
    const h = harness();
    h.autosave.stage(task, { title: 'Unknown title' });
    h.autosave.commit(task.id, ['title']);
    const original = h.sent[0]?.input ?? null;
    h.state.held = original;
    h.next().reject(new Outcome('unknown'));
    await h.settle();
    expect(h.autosave.get(task.id)?.phase).toBe('unknown');
    expect(h.autosave.getPaused()).toBe(task.id);

    // Never retried automatically; later fields wait behind it.
    h.autosave.choose(task, { priority: 'urgent' });
    await h.settle();
    expect(h.sent).toHaveLength(1);
    expect(h.resent).toHaveLength(0);

    h.autosave.retry(task.id);
    h.autosave.retry(task.id);
    expect(h.resent).toHaveLength(1);
    expect(h.resent[0]).toBe(original);

    h.next().resolve(confirmed({ title: 'Unknown title' }, 2));
    await h.settle();
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]?.input).toEqual({ expectedRevision: 2, priority: 'urgent' });
  });

  it('stops the queue on a conflict until an explicit review and never rebases by itself', async () => {
    const h = harness();
    h.autosave.stage(task, { title: 'Mine' });
    h.autosave.commit(task.id, ['title']);
    h.next().reject(new Outcome('conflict'));
    await h.settle();
    expect(h.autosave.get(task.id)?.phase).toBe('conflict');

    h.autosave.choose(task, { priority: 'low' });
    h.autosave.retry(task.id);
    await h.settle();
    expect(h.sent).toHaveLength(1);

    const latest = confirmed({ description: 'Colleague text' }, 5);
    h.autosave.resolveReview(task.id, latest, true);
    expect(h.sent[1]?.input).toEqual({ expectedRevision: 5, title: 'Mine', priority: 'low' });
    expect(h.autosave.get(task.id)?.draft.description).toBe('Colleague text');
  });

  it('sends nothing without the current right, outside the current scope or after disposal', async () => {
    const h = harness();
    h.autosave.authorize(task.id, false);
    h.autosave.choose(task, { priority: 'high' });
    expect(h.sent).toHaveLength(0);
    h.autosave.authorize(task.id, true);
    expect(h.sent).toHaveLength(1);
    h.next().resolve(confirmed({ priority: 'high' }, 2));
    await h.settle();

    h.state.allowed = false;
    h.autosave.choose(confirmed({ priority: 'high' }, 2), { priority: 'low' });
    expect(h.sent).toHaveLength(1);
    h.autosave.dispose();
    h.state.allowed = true;
    h.autosave.pump();
    h.autosave.commit(task.id, ['priority']);
    expect(h.sent).toHaveLength(1);
  });

  it('keeps an invalid field local with its error while a valid committed field is sent alone', () => {
    const h = harness();
    h.autosave.stage(task, { title: '   ', priority: 'medium' });
    h.autosave.commit(task.id, ['title', 'priority']);
    expect(h.sent[0]?.input).toEqual({ expectedRevision: 1, priority: 'medium' });
    expect(h.autosave.get(task.id)?.errors.title).toBeDefined();
    expect(h.autosave.get(task.id)?.draft.title).toBe('   ');
  });
  it('retires duplicate close/blur commits after the same in-flight fields are acknowledged', async () => {
    const h = harness();
    h.autosave.stage(task, { title: 'Confirmed once' });
    h.autosave.commit(task.id, ['title']);
    h.autosave.flush(task.id);
    h.autosave.flush(task.id);
    expect(h.sent).toHaveLength(1);
    h.next().resolve(confirmed({ title: 'Confirmed once' }, 2));
    await h.settle();
    expect(h.sent).toHaveLength(1);
    expect(h.autosave.get(task.id)?.committed).toEqual([]);
    expect(h.autosave.hasRetained()).toBe(false);
    expect(h.mirror.has(task.id)).toBe(false);
  });

});
