import { expect, it } from 'vitest';
import { alpha, anna } from '../../test/fakeApi';
import { createQueryClient } from '../../lib/queryClient';
import { queryKeys } from '../../lib/queryKeys';
import { storeTask } from '../tasks/queries';
import { buildCreateInput, buildUpdateInput, draftFromTask, emptyDraft } from '../tasks/taskDraft';
import { scheduledTask, PROJECT_ID } from './test/fixtures';

it('keeps a canonical start date when an old stored task response omits the optional property', async () => {
  const client = createQueryClient({ retry: false });
  const current = scheduledTask(1, '2026-10-19', '2026-10-25');
  const replay = { ...current }; delete replay.startDate;
  const key = queryKeys.task(anna.id, alpha.id, current.id);
  client.setQueryData(key, current);
  try {
    await storeTask(client, anna.id, alpha.id, replay);
    expect(client.getQueryData(key)).toEqual(current);
    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
  } finally { client.clear(); }
});

it('keeps absent start dates out of old create/PATCH shapes while allowing explicit set and clear', () => {
  const task = scheduledTask(1, null, '2026-10-25');
  const base = draftFromTask(task);
  const oldDraft = emptyDraft(task.statusId, null); oldDraft.title = 'Без новой даты'; delete oldDraft.startDate;
  const create = buildCreateInput(PROJECT_ID, oldDraft, { parentTaskId: null, workScope: 'added_scope' });
  expect(create.ok).toBe(true);
  if (create.ok) expect(create.input).not.toHaveProperty('startDate');
  const patch = buildUpdateInput(task, base, { ...base, startDate: '2026-10-19' });
  expect(patch).toEqual({ ok: true, input: { expectedRevision: 1, startDate: '2026-10-19' } });
  const dated = { ...task, startDate: '2026-10-19' };
  const datedBase = draftFromTask(dated);
  expect(buildUpdateInput(dated, datedBase, { ...datedBase, startDate: '' })).toEqual({ ok: true, input: { expectedRevision: 1, startDate: null } });
  expect(buildUpdateInput(task, base, { ...base, startDate: '0000-01-01' }).ok).toBe(false);
  expect(buildUpdateInput(task, base, { ...base, startDate: '2026-10-26' }).ok).toBe(false);
});
