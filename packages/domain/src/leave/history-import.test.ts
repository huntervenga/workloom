import { describe, expect, it } from 'vitest';
import * as C from '@workloom/contracts';
import { createLeaveService } from './service.js';
import type { LeaveDependencies, LeaveScope, LeaveStoredSource } from './ports.js';
import type { CommandContext } from '../access/context.js';
const id = (n: number) => `77000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture(workspaceTimezone: string, personTimezone: string) {
  const workspaceId = id(1), membershipId = id(2), userId = id(3), typeId = id(4);
  const context: CommandContext = { workspaceId, actor: { userId, kind: 'real', displayName: 'Synthetic owner' }, source: 'import', requestId: 'synthetic' };
  const member = { id: membershipId, workspaceId, userId, displayName: 'Synthetic owner', role: 'owner' as const, state: 'active' as const, revision: 1 };
  const stored: LeaveStoredSource = { settings: { workspaceId, revision: 1, timezone: 'UTC', defaultWeeklyMinutes: [480, 480, 480, 480, 480, 0, 0], policyVersions: [{ effectiveYear: 2026, holidays: [], types: [{ id: typeId, name: 'Vacation', color: '#123456', annualEntitlementMicrodays: 0, accrualMethod: 'daily', carryover: { mode: 'none', capMicrodays: null, expiresAfterMonths: null }, allowNegative: false, maxNegativeMicrodays: null, consumesBalance: true, pausesAccrual: false, capacityUnavailable: true, requiresApproval: true, archived: false }] }] }, profiles: [{ workspaceId, membershipId, revision: 1, timezone: personTimezone, employmentStart: '2026-01-01', employmentEnd: null, accountingStart: '2026-01-01', openingBalances: [], schedulePeriods: [] }], requests: [], adjustments: [], members: [member], head: '0:1' };
  const repository: LeaveScope['repository'] = { source: async () => stored, isRealUser: async () => true, saveSettings: async () => { throw Error('Read only'); }, saveProfile: async () => { throw Error('Read only'); }, saveRequest: async () => { throw Error('Read only'); }, addAdjustment: async () => { throw Error('Read only'); }, receipt: async () => null, saveReceipt: async () => { throw Error('Read only'); } };
  const scope: LeaveScope = { context, access: { workspace: { id: workspaceId, name: 'Synthetic', timezone: workspaceTimezone, weekStart: 1 }, membership: member }, barrierAt: new Date('2026-10-21T00:30:00.000Z'), repository, recordChange: async () => { throw Error('Read only'); } };
  const dependencies: LeaveDependencies = { newId: () => id(9), digest: () => 'f'.repeat(64), read: async (_ctx, _capability, work) => work(scope), write: async () => { throw Error('Read only'); } };
  const input: C.PreviewLeaveHistoryInput = { source: { sha256: 'a'.repeat(64), sheet: 'Vacations' }, rows: [{ membershipId, typeId, sourceRows: [2], startDate: '2026-10-21', endDate: '2026-10-21', note: '' }], reason: 'Synthetic history' };
  return { service: createLeaveService(dependencies), context, input };
}
describe('historical import cutoff and contract bounds', () => {
  it('checks person local today even when workspace day has already advanced', async () => { const f = fixture('UTC', 'Pacific/Honolulu'); await expect(f.service.previewHistory(f.context, f.input)).rejects.toMatchObject({ code: 'DOMAIN_VALIDATION_FAILED' }); });
  it('checks workspace local today even when person day has already advanced', async () => { const f = fixture('Pacific/Honolulu', 'UTC'); await expect(f.service.previewHistory(f.context, f.input)).rejects.toMatchObject({ code: 'DOMAIN_VALIDATION_FAILED' }); });
  it('previews elapsed local dates without writes or invented policy approval', async () => { const f = fixture('UTC', 'Pacific/Honolulu'); const input = { ...f.input, rows: f.input.rows.map(row => ({ ...row, startDate: '2026-10-20', endDate: '2026-10-20' })) }; expect((await f.service.previewHistory(f.context, input)).rows[0]?.totalMicrodays).toBe(1_000_000); });
  it('bounds metadata and rejects duplicate rows, empty reason and normal-request provenance forgery', () => {
    const f = fixture('UTC', 'UTC'), row = f.input.rows[0];
    expect(C.previewLeaveHistoryInputSchema.safeParse({ ...f.input, rows: Array.from({ length: 51 }, (_, i) => ({ ...row, sourceRows: [i + 1] })) }).success).toBe(false);
    expect(C.previewLeaveHistoryInputSchema.safeParse({ ...f.input, rows: [row, row] }).success).toBe(false);
    expect(C.previewLeaveHistoryInputSchema.safeParse({ ...f.input, reason: '  ' }).success).toBe(false);
    expect(C.importLeaveHistoryInputSchema.safeParse(f.input).success).toBe(false);
    expect(C.createLeaveRequestInputSchema.safeParse({ membershipId: id(2), typeId: id(4), startDate: '2026-10-20', endDate: '2026-10-20', historicalImport: { sourceFileSha256: 'a'.repeat(64), sheet: 'Vacations', sourceRows: [2], importedAt: '2026-10-21T00:30:00.000Z' } }).success).toBe(false);
  });
});
