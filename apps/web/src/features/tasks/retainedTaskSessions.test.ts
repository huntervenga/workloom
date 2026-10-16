import { describe, expect, it, vi } from 'vitest';
import { task } from '../planning/test/fixtures';
import { createRetainedTaskSessions } from './retainedTaskSessions';
import { draftFromTask, emptyDraft } from './taskDraft';
import type { CreateSession, EditSession } from './useTaskCommands';
const dirty = (title = 'Retained task'): EditSession => ({ base: task, draft: { ...draftFromTask(task), title } });
const create = (): CreateSession => ({ request: { sectionId: null, parent: null }, draft: { ...emptyDraft('explicit-status-choice', null), title: '' }, workScope: 'detail' });

describe('page-owned ordinary task session aggregation', () => {
  it('keeps Map chaining and session identities while notifying only aggregate changes', () => {
    const sessions = createRetainedTaskSessions(); const listener = vi.fn(); sessions.subscribe(listener);
    const first = dirty(); const second = dirty('Other retained task'); const map = sessions.editSessions.current;
    expect(map).toBeInstanceOf(Map); expect(map.set(task.id, first)).toBe(map); expect(map.get(task.id)).toBe(first);
    map.set('other', second); expect(listener).toHaveBeenCalledTimes(1); expect(sessions.getSnapshot()).toBe(true);
    expect(map.delete(task.id)).toBe(true); expect(map.get('other')).toBe(second); expect(sessions.getSnapshot()).toBe(true);
    map.set('other', { base: task, draft: draftFromTask(task) }); expect(sessions.getSnapshot()).toBe(false); expect(listener).toHaveBeenCalledTimes(2);
    expect(map.delete('missing')).toBe(false); map.clear(); expect(listener).toHaveBeenCalledTimes(2);
  });
  it('uses semantic edit dirtiness rather than clean kept forms or text formatting differences', () => {
    const sessions = createRetainedTaskSessions();
    sessions.editSessions.current.set(task.id, { base: task, draft: { ...draftFromTask(task), title: ` ${task.title} ` } });
    expect(sessions.getSnapshot()).toBe(false);
    sessions.editSessions.current.set(task.id, { base: task, draft: { ...draftFromTask(task), description: 'Retain raw description' } });
    expect(sessions.getSnapshot()).toBe(true); sessions.editSessions.current.clear(); expect(sessions.getSnapshot()).toBe(false);
  });
  it('retains explicit create intent without guessing away a status-only choice from its current empty title', () => {
    const sessions = createRetainedTaskSessions(); const retained = create(); sessions.createSession.current = retained;
    expect(sessions.createSession.current).toBe(retained); expect(sessions.getSnapshot()).toBe(true);
    sessions.editSessions.current.set(task.id, dirty()); sessions.createSession.current = null; expect(sessions.getSnapshot()).toBe(true);
    sessions.editSessions.current.delete(task.id); expect(sessions.getSnapshot()).toBe(false);
  });
  it('publishes changes synchronously and detaches only the removed subscription', () => {
    const sessions = createRetainedTaskSessions(); const seen: boolean[] = []; const stop = sessions.subscribe(() => seen.push(sessions.getSnapshot()));
    sessions.createSession.current = create(); expect(seen).toEqual([true]);
    stop(); sessions.createSession.current = null; expect(seen).toEqual([true]); expect(sessions.getSnapshot()).toBe(false);
  });
});
