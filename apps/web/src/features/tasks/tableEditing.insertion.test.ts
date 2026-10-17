import type { CreateTaskInput, TaskDto } from '@workloom/contracts';
import { describe, expect, it } from 'vitest';
import { alphaMembers } from '../../test/fakeApi';
import { PROJECT_ID, task } from '../planning/test/fixtures';
import { buildCreateInput, emptyDraft } from './taskDraft';
import { canResumeQuickSession, freshQuickSession, quickCreateOptions, quickDraftChanges } from './tableEditing';
import { resolveQuickCreateInput, type CreateRequest, type CreateSession } from './useTaskCommands';

const SECTION = 'e1000000-0000-4000-8000-000000000001';
const OTHER_SECTION = 'e1000000-0000-4000-8000-000000000002';
const STATUS_PROGRESS = 'f6000000-0000-4000-8000-000000000002';
const B_ID = 'f2000000-0000-4000-8000-0000000000b1';
const X_ID = 'f2000000-0000-4000-8000-0000000000e1';
const afterB: CreateRequest = { sectionId: SECTION, parent: null, insertion: { anchorTaskId: B_ID, placement: 'after' } };
const parent: TaskDto = { ...task, sectionId: OTHER_SECTION };
const input: CreateTaskInput = { projectId: PROJECT_ID, sectionId: SECTION, title: 'Queued', statusId: task.statusId };
const withDraft = (session: CreateSession, patch: Partial<CreateSession['draft']>): CreateSession => ({ ...session, draft: { ...session.draft, ...patch } });

describe('fresh quick sessions', () => {
  it('keeps the old root shape and adds a distinct stable row key per draft', () => {
    const first = freshQuickSession(SECTION, task.statusId);
    const second = freshQuickSession(SECTION, task.statusId);
    expect(first).toMatchObject({ request: { sectionId: SECTION, parent: null }, draft: emptyDraft(task.statusId, SECTION), workScope: 'detail', origin: 'quick' });
    expect(first.request).not.toHaveProperty('insertion');
    expect(first.clientId).toEqual(expect.any(String));
    expect(first.clientId).not.toBe(second.clientId);
  });

  it('places a subtask in its parent section whatever row opened it, and keeps the insertion', () => {
    const session = freshQuickSession(SECTION, task.statusId, { sectionId: SECTION, parent, insertion: { anchorTaskId: B_ID, placement: 'before' } });
    expect(session.request).toEqual({ sectionId: OTHER_SECTION, parent, insertion: { anchorTaskId: B_ID, placement: 'before' } });
    expect(session.draft.sectionId).toBe(OTHER_SECTION);
  });

  it('builds a detail subtask create without any estimate and a root create with it', () => {
    const child = withDraft(freshQuickSession(SECTION, task.statusId, { sectionId: SECTION, parent }), { title: 'Child', estimate: '2' });
    const childInput = buildCreateInput(PROJECT_ID, child.draft, quickCreateOptions(child));
    expect(childInput).toEqual({ ok: true, input: { projectId: PROJECT_ID, sectionId: OTHER_SECTION, parentTaskId: parent.id, workScope: 'detail', title: 'Child', statusId: task.statusId } });
    const root = withDraft(freshQuickSession(SECTION, task.statusId), { title: 'Root', estimate: '2' });
    expect(buildCreateInput(PROJECT_ID, root.draft, quickCreateOptions(root))).toEqual({ ok: true, input: { projectId: PROJECT_ID, sectionId: SECTION, title: 'Root', statusId: task.statusId, estimateMinutes: 120 } });
  });

  it('counts a changed status as a draft value of a fresh row', () => {
    expect(quickDraftChanges(withDraft(freshQuickSession(SECTION, task.statusId), { statusId: STATUS_PROGRESS }))).toEqual(['statusId']);
  });
});

describe('resuming a quick session', () => {
  const full = withDraft(freshQuickSession(SECTION, task.statusId, afterB), {
    title: 'Full', statusId: STATUS_PROGRESS, responsibleMembershipId: alphaMembers[0]?.id ?? null, participantMembershipIds: [alphaMembers[0]?.id ?? ''],
    startDate: '2026-10-19', dueDate: '2026-10-20', priority: 'high', tagIds: [], estimate: '1',
  });

  it('resumes every built-in value only in a full row at the same insertion point', () => {
    expect(canResumeQuickSession(full, SECTION, afterB, true)).toBe(true);
    expect(canResumeQuickSession(full, SECTION, afterB)).toBe(false);
    expect(canResumeQuickSession(full, SECTION, undefined, true)).toBe(false);
    expect(canResumeQuickSession(full, SECTION, { ...afterB, insertion: { anchorTaskId: B_ID, placement: 'before' } }, true)).toBe(false);
    expect(canResumeQuickSession(withDraft(full, { description: 'Only in details' }), SECTION, afterB, true)).toBe(false);
  });

  it('keeps old title-only fixtures resumable and other parents foreign', () => {
    const old: CreateSession = { request: { sectionId: SECTION, parent: null }, workScope: 'detail', origin: 'quick', draft: { ...emptyDraft(task.statusId, SECTION), title: 'Old' } };
    expect(canResumeQuickSession(old, SECTION)).toBe(true);
    const child = withDraft(freshQuickSession(SECTION, task.statusId, { sectionId: SECTION, parent }), { title: 'Child', dueDate: '2026-10-20' });
    expect(canResumeQuickSession(child, SECTION)).toBe(false);
    expect(canResumeQuickSession(child, SECTION, { sectionId: SECTION, parent }, true)).toBe(true);
    expect(canResumeQuickSession(child, SECTION, { sectionId: SECTION, parent: { ...parent, id: X_ID } }, true)).toBe(false);
    // An estimate on a detail subtask would never be sent, so it is not resumed into the row.
    expect(canResumeQuickSession(withDraft(child, { estimate: '1' }), SECTION, { sectionId: SECTION, parent }, true)).toBe(false);
  });
});

describe('resolving a queued create place', () => {
  const entry = (request: CreateRequest) => ({ session: { ...freshQuickSession(SECTION, task.statusId), request }, input });

  it('sends an unplaced create exactly as queued', () => {
    expect(resolveQuickCreateInput(entry({ sectionId: SECTION, parent: null }))).toBe(input);
  });

  it('places a create next to its row without changing the queued snapshot', () => {
    expect(resolveQuickCreateInput(entry(afterB))).toEqual({ ...input, insertion: { anchorTaskId: B_ID, placement: 'after' } });
    expect(input).not.toHaveProperty('insertion');
  });

  it('never resolves a follower before its predecessor task is known, then follows that task', () => {
    const anchor = { taskId: null as string | null };
    const follower = entry({ ...afterB, insertionAnchor: anchor });
    expect(resolveQuickCreateInput(follower)).toBeNull();
    anchor.taskId = X_ID;
    expect(resolveQuickCreateInput(follower)).toEqual({ ...input, insertion: { anchorTaskId: X_ID, placement: 'after' } });
    expect(resolveQuickCreateInput(entry({ ...afterB, insertionAnchor: { taskId: X_ID, placement: 'before' } }))?.insertion).toEqual({ anchorTaskId: X_ID, placement: 'before' });
  });
});
