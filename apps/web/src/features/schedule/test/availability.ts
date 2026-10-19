import { leaveAvailabilityInputSchema, leaveAvailabilitySchema } from '@workloom/contracts';
import { expect } from 'vitest';
import { ok, type FakeRequest, type RouteTable } from '../../../test/fakeApi';
import { rootPath } from './fixtures';

const availabilityPath = `${rootPath}/time-off/availability`;
/** One deliberately classified read. A keyed request still counts as a protected write. */
export function isAvailabilityRead(request: FakeRequest): boolean {
  return request.method === 'POST' && request.path === availabilityPath && !request.headers.has('Idempotency-Key');
}
/** Legacy schedule fixtures have no leave policy; request/response still use the real contract. */
export const availabilityReadRoutes: RouteTable = {
  [`POST ${availabilityPath}`]: request => {
    expect(request.headers.has('Idempotency-Key')).toBe(false);
    const input = leaveAvailabilityInputSchema.parse(request.body);
    return ok(leaveAvailabilitySchema.parse({
      startDate: input.startDate, endDate: input.endDate, settingsConfigured: false,
      sourceVersion: 'a'.repeat(64), days: [], members: [], intervals: [], companyHolidays: [],
      totals: { scheduledMinutes: 0, holidayMinutes: 0, absenceMinutes: 0, availableMinutes: 0, unconfiguredMembers: 0 },
      inputVersions: { settingsRevision: 0, profiles: [], requests: [] },
    }));
  },
};
