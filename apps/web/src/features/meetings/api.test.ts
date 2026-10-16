import type { RecordedWorkLogDto } from '@workloom/contracts';
import { describe, expect, it } from 'vitest';
import { installFakeApi, json } from '../../test/fakeApi';
import { log, PERIOD_A, rootPath } from '../planning/test/fixtures';
import { recordedWorkLabel } from '../../shared/RecordedWorkLabel';
import { fetchRecordedWork } from './api';
describe('canonical recorded source collection',()=>{
 it('fully pages manual and attendance sources without coercing old manual replay shape or period precision',async()=>{
  const manual=log(120);const attendance:RecordedWorkLogDto={...manual,id:'a1000000-0000-4000-8000-000000000001',sourceKind:'meeting_attendance',precision:'occurrence',meetingId:'a2000000-0000-4000-8000-000000000001',attendanceId:'a3000000-0000-4000-8000-000000000001',confirmedMeetingRevision:1,minutes:0,attribution:{basis:'planned_absence',plannedStartAt:'2026-10-20T09:00:00.000Z',actualStartAt:null}};
  const {calls}=installFakeApi({[`GET ${rootPath}/recorded-work`]:(request)=>json(200,{data:request.searchParams.has('cursor')?[attendance]:[manual],meta:{requestId:'test_page',nextCursor:request.searchParams.has('cursor')?null:'cursor_next'}})});
  const result=await fetchRecordedWork(manual.workspaceId,PERIOD_A);expect(result).toEqual([manual,attendance]);expect(result[0]).not.toHaveProperty('category');expect(calls).toHaveLength(2);expect(calls[1]?.searchParams.get('cursor')).toBe('cursor_next');expect(recordedWorkLabel(manual)).toBe("Weekly entry");expect(recordedWorkLabel(attendance)).toContain("Planned absence");expect(recordedWorkLabel(attendance)).toContain('UTC');expect(recordedWorkLabel(attendance)).not.toContain("Weekly entry");
 });
});
