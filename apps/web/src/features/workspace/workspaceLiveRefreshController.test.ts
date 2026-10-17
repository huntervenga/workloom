import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceChangeHeadDto } from '@workloom/contracts';
import { ApiError } from '../../lib/api';
import { WorkspaceLiveRefreshController } from './workspaceLiveRefreshController';
import type { WorkspaceRefreshResult } from './workspaceLiveQueries';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
function head(sequence = '0', overrides: Partial<WorkspaceChangeHeadDto> = {}): WorkspaceChangeHeadDto {
  return { actorUserId: ACTOR, workspaceId: WORKSPACE, membershipId: '33333333-3333-4333-8333-333333333333',
    membershipRevision: 1, role: 'member', changeSeq: sequence, permissionEpoch: '0', ...overrides };
}
function held<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { for (let index = 0; index < 12; index++) await Promise.resolve(); }
const controllers: WorkspaceLiveRefreshController[] = [];
function setup() {
  const readHead = vi.fn<(signal: AbortSignal, previous: WorkspaceChangeHeadDto | null) => Promise<WorkspaceChangeHeadDto>>().mockResolvedValue(head());
  const refresh = vi.fn<(signal: AbortSignal, safe: () => boolean) => Promise<WorkspaceRefreshResult>>()
    .mockResolvedValue({ complete: true, followUp: false });
  const protectedState = { active: false };
  const recheckAccess = vi.fn();
  const rejectedHead = vi.fn();
  const controller = new WorkspaceLiveRefreshController({ readHead, refresh, protected: () => protectedState.active, recheckAccess, rejectedHead });
  controllers.push(controller);
  return { controller, readHead, refresh, protectedState, recheckAccess, rejectedHead };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => { controllers.splice(0).forEach(controller => controller.stop()); vi.useRealTimers(); });

describe('workspace live refresh lifecycle', () => {
  it('catches the initial loading race at zero; equal five-second heads do not repeat a successful refresh', async () => {
    const s = setup(); s.controller.setVisible(true); await settle();
    expect(s.refresh).toHaveBeenCalledTimes(1);
    expect(s.controller.appliedHead?.changeSeq).toBe('0');
    await vi.advanceTimersByTimeAsync(4_999); expect(s.readHead).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(s.readHead).toHaveBeenCalledTimes(2);
    expect(s.refresh).toHaveBeenCalledTimes(1);
    s.readHead.mockResolvedValue(head('9007199254740993'));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(s.controller.appliedHead?.changeSeq).toBe('9007199254740993');
    expect(s.refresh).toHaveBeenCalledTimes(2);
  });

  it('never overlaps head reads, coalesces focus, polls only while visible and immediately resumes', async () => {
    const s = setup(); const request = held<WorkspaceChangeHeadDto>(); s.readHead.mockReturnValueOnce(request.promise);
    s.controller.setVisible(true); s.controller.wake(); s.controller.wake();
    await vi.advanceTimersByTimeAsync(20_000); expect(s.readHead).toHaveBeenCalledTimes(1);
    const signal = s.readHead.mock.calls[0]?.[0];
    s.controller.setVisible(false); expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(20_000); expect(s.readHead).toHaveBeenCalledTimes(1);
    s.controller.setVisible(true); await settle(); expect(s.readHead).toHaveBeenCalledTimes(2);
    request.resolve(head('20')); await settle();
    expect(s.controller.observedHead?.changeSeq).toBe('0');
    expect(s.refresh).toHaveBeenCalledTimes(1);
  });

  it('retains a failed refresh and retries even when the next head is equal', async () => {
    const s = setup(); s.refresh.mockResolvedValueOnce({ complete: false, followUp: false });
    s.controller.setVisible(true); await settle();
    expect(s.controller.observedHead?.changeSeq).toBe('0'); expect(s.controller.appliedHead).toBeNull();
    expect(s.controller.pending).toBe(true); expect(s.refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(s.refresh).toHaveBeenCalledTimes(2); expect(s.controller.pending).toBe(false);
  });

  it('applies only the captured target while newer heads coalesce into one subsequent catch-up', async () => {
    const s = setup(); const first = held<WorkspaceRefreshResult>(); const second = held<WorkspaceRefreshResult>();
    s.refresh.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    s.controller.setVisible(true); await settle();
    s.readHead.mockResolvedValue(head('2')); await vi.advanceTimersByTimeAsync(5_000);
    s.readHead.mockResolvedValue(head('9')); await vi.advanceTimersByTimeAsync(5_000);
    expect(s.refresh).toHaveBeenCalledTimes(1); expect(s.controller.appliedHead).toBeNull();
    first.resolve({ complete: true, followUp: false }); await settle();
    expect(s.controller.appliedHead?.changeSeq).toBe('0'); expect(s.controller.observedHead?.changeSeq).toBe('9');
    expect(s.refresh).toHaveBeenCalledTimes(2); expect(s.controller.pending).toBe(true);
    second.resolve({ complete: true, followUp: false }); await settle();
    expect(s.controller.appliedHead?.changeSeq).toBe('9'); expect(s.controller.pending).toBe(false);
  });

  it('suspends head and content while protected, then reauthorizes once on release before catch-up', async () => {
    const s = setup(); s.protectedState.active = true; s.controller.setVisible(true); await settle();
    s.readHead.mockResolvedValue(head('8')); await vi.advanceTimersByTimeAsync(15_000);
    expect(s.readHead).not.toHaveBeenCalled(); expect(s.refresh).not.toHaveBeenCalled();
    s.protectedState.active = false; s.controller.interactionChanged(); s.controller.interactionChanged(); await settle();
    expect(s.readHead).toHaveBeenCalledTimes(1); expect(s.refresh).toHaveBeenCalledTimes(1);
    expect(s.controller.appliedHead?.changeSeq).toBe('8');
  });

  it('defers access metadata while protected and rechecks a changed role/revision/epoch after release', async () => {
    const s = setup(); s.controller.setVisible(true); await settle();
    s.protectedState.active = true; s.controller.interactionChanged();
    s.readHead.mockResolvedValue(head('0', { role: 'viewer', membershipRevision: 2, permissionEpoch: '1' }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.recheckAccess).not.toHaveBeenCalled(); expect(s.readHead).toHaveBeenCalledTimes(1);
    s.protectedState.active = false; s.controller.interactionChanged(); await settle();
    expect(s.recheckAccess).toHaveBeenCalledTimes(1); expect(s.readHead).toHaveBeenCalledTimes(2);
  });

  it.each(['unauthenticated', 'forbidden', 'not_found'] as const)('suspends an idle %s denial until a new authorized owner is mounted', async kind => {
    const s = setup();
    s.readHead.mockRejectedValue(new ApiError({ kind, status: kind === 'unauthenticated' ? 401 : kind === 'forbidden' ? 403 : 404 }));
    s.controller.setVisible(true); await settle();
    s.controller.wake(); s.controller.setVisible(false); s.controller.setVisible(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(s.readHead).toHaveBeenCalledTimes(1); expect(s.refresh).not.toHaveBeenCalled();
    expect(s.rejectedHead).toHaveBeenCalledTimes(1);
  });

  it('aborts a pre-protection head and ignores its delayed denial; release requires a new authorized head', async () => {
    const s = setup(); const old = held<WorkspaceChangeHeadDto>(); s.readHead.mockReturnValueOnce(old.promise);
    s.controller.setVisible(true); await settle();
    const oldSignal = s.readHead.mock.calls[0]?.[0];
    s.protectedState.active = true; s.controller.interactionChanged(); expect(oldSignal?.aborted).toBe(true);
    old.reject(new ApiError({ kind: 'forbidden', status: 403 })); await settle();
    expect(s.rejectedHead).not.toHaveBeenCalled(); expect(s.controller.observedHead).toBeNull();
    await vi.advanceTimersByTimeAsync(15_000); expect(s.readHead).toHaveBeenCalledTimes(1);
    s.protectedState.active = false; s.controller.interactionChanged(); await settle();
    expect(s.readHead).toHaveBeenCalledTimes(2); expect(s.controller.appliedHead?.changeSeq).toBe('0');
  });

  it.each(['network', 'unavailable', 'invalid_response'] as const)('keeps pending work through %s and rejects regressing decimal heads', async kind => {
    const s = setup(); s.refresh.mockResolvedValueOnce({ complete: false, followUp: false });
    s.readHead.mockResolvedValueOnce(head('9007199254740994'));
    s.controller.setVisible(true); await settle();
    s.readHead.mockRejectedValueOnce(new ApiError({ kind, status: kind === 'network' ? null : 503 }));
    await vi.advanceTimersByTimeAsync(5_000); expect(s.controller.pending).toBe(true);
    s.readHead.mockResolvedValueOnce(head('9007199254740993'));
    await vi.advanceTimersByTimeAsync(5_000); expect(s.controller.observedHead?.changeSeq).toBe('9007199254740994');
    expect(s.controller.appliedHead).toBeNull();
    s.readHead.mockResolvedValue(head('9007199254740994')); await vi.advanceTimersByTimeAsync(5_000);
    expect(s.controller.appliedHead?.changeSeq).toBe('9007199254740994');
  });

  it('does not publish a stopped scope response or complete a cancelled catch-up', async () => {
    const s = setup(); const refresh = held<WorkspaceRefreshResult>(); s.refresh.mockReturnValue(refresh.promise);
    s.controller.setVisible(true); await settle(); const signal = s.refresh.mock.calls[0]?.[0];
    s.controller.stop(); expect(signal?.aborted).toBe(true);
    refresh.resolve({ complete: true, followUp: false }); await settle();
    expect(s.controller.appliedHead).toBeNull();
    await vi.advanceTimersByTimeAsync(10_000); expect(s.readHead).toHaveBeenCalledTimes(1);
  });

  it('follows up once for active queries mounted or reenabled during successful catch-up', async () => {
    const s = setup(); s.refresh.mockResolvedValueOnce({ complete: true, followUp: true });
    s.controller.setVisible(true); await settle();
    expect(s.refresh).toHaveBeenCalledTimes(2); expect(s.controller.pending).toBe(false);
  });
});
