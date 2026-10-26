import { describe, expect, it, vi } from 'vitest';
import type { UserSettingsDto } from '@workloom/contracts';
import { createUserSettingsService, type UserSettingsRepository } from './user-settings.js';
const actor = { userId: 'aa000000-0000-4000-8000-000000000001', displayName: 'Person', kind: 'real' as const };
const context = { actor, source: 'web' as const, requestId: 'settings-test' };
function harness() {
  let value: UserSettingsDto | null = null;
  const repo: UserSettingsRepository = { userExists: vi.fn(async () => true), get: vi.fn(async () => value), put: vi.fn(async next => { value = next; }) };
  const run = <T>(work: (repository: UserSettingsRepository) => Promise<T>) => work(repo);
  return { repo, service: createUserSettingsService({ read: run, write: run }, () => new Date('2026-10-26T10:00:00.000Z')) };
}
describe('account settings', () => {
  it('reads a default without creating a row, and persists only an explicit change', async () => {
    const { repo, service } = harness();
    expect(await service.get(context)).toEqual({ userId: actor.userId, revision: 0, settings: { version: 1, theme: 'default' }, updatedAt: null });
    expect(repo.put).not.toHaveBeenCalled();
    const saved = await service.update(context, { expectedUserId: actor.userId.toUpperCase(), expectedRevision: 0, settings: { theme: 'dark' } });
    expect(saved).toMatchObject({ revision: 1, settings: { version: 1, theme: 'dark' } });
    expect(await service.get(context)).toEqual(saved);
    await service.update(context, { expectedUserId: actor.userId, expectedRevision: 1, settings: { theme: 'dark' } });
    expect(repo.put).toHaveBeenCalledTimes(1);
  });
  it('rejects stale revisions, changed accounts and unknown settings without writes', async () => {
    const { repo, service } = harness();
    await expect(service.update(context, { expectedUserId: actor.userId, expectedRevision: 2, settings: { theme: 'light' } })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    await expect(service.update(context, { expectedUserId: actor.userId.replace(/1$/, '2'), expectedRevision: 0, settings: { theme: 'light' } })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(service.update(context, { expectedUserId: actor.userId, expectedRevision: 0, settings: { theme: 'light', role: 'admin' } } as never)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(repo.put).not.toHaveBeenCalled();
  });
  it('requires an existing authenticated user for both reads and writes', async () => {
    const { repo, service } = harness(); vi.mocked(repo.userExists).mockResolvedValue(false);
    await expect(service.get(context)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(service.update(context, { expectedUserId: actor.userId, expectedRevision: 0, settings: { theme: 'dark' } })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(repo.get).not.toHaveBeenCalled(); expect(repo.put).not.toHaveBeenCalled();
  });
});
