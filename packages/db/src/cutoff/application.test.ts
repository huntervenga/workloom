import { describe, expect, it, vi } from 'vitest';
import type { CutoffJob } from '@workloom/contracts';
import { DomainError, type CommandContext } from '@workloom/domain';
import type { WorkloomExecutor } from '../client.js';
import { createCutoffApplication } from './application.js';
import { createCutoffWorkerFacade } from './worker-facade.js';
const id = 'abcdef00-0000-4000-8000-000000000001';
const context: CommandContext = { workspaceId: id, actor: { userId: id, displayName: 'Synthetic', kind: 'fixture' }, source: 'web', requestId: 'cutoff-read-test' };
const job: CutoffJob = { schemaVersion: 1, requestId: id, workspaceId: id, projectId: id, periodId: id, grantId: id, grantRevision: 1, periodRevision: 1, cutoffAt: '2026-10-16T10:00:00.000Z', sourceManifestHash: 'a'.repeat(64) };
function unavailable(error: unknown) { return { transaction: vi.fn().mockRejectedValue(error) } as unknown as WorkloomExecutor; }
describe('cutoff read adapter failures', () => {
  it.each(['ECONNREFUSED','42P01','57014'])('maps readiness pre-transaction failure %s to a controlled retryable error', async code => {
    await expect(createCutoffApplication(unavailable(Object.assign(new Error('Synthetic database detail'), { code }))).getReadiness(context, id)).rejects.toMatchObject({ code: 'TEMPORARILY_UNAVAILABLE', retryable: true });
  });
  it('maps worker grant pre-resolution failure and preserves typed access failures', async () => {
    await expect(createCutoffWorkerFacade(unavailable(Object.assign(new Error('Synthetic database detail'), { code: 'ECONNREFUSED' }))).freezeDuePeriod(job)).rejects.toMatchObject({ code: 'TEMPORARILY_UNAVAILABLE', retryable: true });
    const denied = new DomainError('NOT_FOUND', 'The requested resource was not found.');
    await expect(createCutoffApplication(unavailable(denied)).getReadiness(context, id)).rejects.toBe(denied);
  });
});
