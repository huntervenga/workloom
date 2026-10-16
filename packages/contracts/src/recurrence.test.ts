import {describe,expect,it} from 'vitest';
import {calendarDateSchema} from './tasks.js';
import {
 recurrenceCalendarDateSchema,recurrenceCalendarSpanDays,recurrenceExceptionPreviewInputSchema,recurrenceScheduleInputSchema,recurrenceSeriesSchema,
} from './recurrence.js';
const id=(n:number)=>`abcdef00-0000-4000-8000-${String(n).padStart(12,'0')}`;
const schedule={startDate:'2026-10-19',localTime:'10:00',timezone:'Asia/Nicosia',frequency:'weekly',weekdays:[1,3],plannedDurationMinutes:30,end:{kind:'on_date',endDate:'2026-12-31'}};
const series={
 id:id(1),workspaceId:id(2),projectId:id(3),revision:1,state:'active',
 currentVersion:{id:id(4),seriesId:id(1),revision:1,effectiveFromNominalDate:'2026-10-19',schedule,
  template:{title:'Standup',statusId:id(5),organizerMembershipId:id(6),attendeeMembershipIds:[id(6)]},
  policyVersion:'first_valid_gap_earlier_overlap_v1',actorUserId:id(7),createdAt:'2026-10-16T00:00:00.000Z',changeSeq:'1'},
 generation:{authorizationId:id(8),authorizationRevision:1,authorizerMembershipId:id(6),state:'ready',blockedCode:null},
 boundPeriodIds:[id(10),id(11)],boundPeriodCount:2,nominalCandidateCount:21,
 createdAt:'2026-10-16T00:00:00.000Z',updatedAt:'2026-10-16T00:00:00.000Z',
};

describe('recurrence calendar dates',()=>{
 it('accepts only real dates inside 2000-01-01..2100-12-31',()=>{
  for(const ok of ['2000-01-01','2100-12-31','2024-02-29','2011-12-30'])expect(recurrenceCalendarDateSchema.safeParse(ok).success).toBe(true);
  for(const bad of ['1999-12-31','2101-01-01','2026-02-29','2100-02-29','2026-04-31','2026-13-01','2026-1-01','0099-01-01'])expect(recurrenceCalendarDateSchema.safeParse(bad).success).toBe(false);
 });
 it('leaves the older task/manual calendar date schema unchanged',()=>{
  expect(calendarDateSchema.safeParse('1999-12-31').success).toBe(true);
  expect(calendarDateSchema.safeParse('2101-01-01').success).toBe(true);
 });
 it('counts inclusive spans with exact ISO years, including two-digit years Date.UTC would remap',()=>{
  expect(recurrenceCalendarSpanDays('2026-10-19','2026-10-19')).toBe(1);
  expect(recurrenceCalendarSpanDays('2024-02-28','2024-03-01')).toBe(3);
  expect(recurrenceCalendarSpanDays('2100-02-28','2100-03-01')).toBe(2);
  expect(recurrenceCalendarSpanDays('0099-12-31','0100-01-01')).toBe(2);
  expect(recurrenceCalendarSpanDays('0000-02-28','0000-03-01')).toBe(3);
  expect(()=>recurrenceCalendarSpanDays('2026-02-30','2026-03-01')).toThrow(RangeError);
 });
 it('applies the range to schedule, end and exception dates',()=>{
  expect(recurrenceScheduleInputSchema.safeParse(schedule).success).toBe(true);
  expect(recurrenceScheduleInputSchema.safeParse({...schedule,startDate:'1999-12-31',end:{kind:'on_date',endDate:'2000-01-05'}}).success).toBe(false);
  expect(recurrenceScheduleInputSchema.safeParse({...schedule,startDate:'2100-12-01',end:{kind:'on_date',endDate:'2101-01-05'}}).success).toBe(false);
  const move={kind:'move',expectedSeriesRevision:1,expectedInstanceRevision:1,reason:'Room change',localDate:'2026-10-21',localTime:'11:00'};
  expect(recurrenceExceptionPreviewInputSchema.safeParse(move).success).toBe(true);
  expect(recurrenceExceptionPreviewInputSchema.safeParse({...move,localDate:'2026-02-30'}).success).toBe(false);
 });
 it('keeps the 366-day on_date bound across a leap year',()=>{
  expect(recurrenceScheduleInputSchema.safeParse({...schedule,startDate:'2024-01-01',end:{kind:'on_date',endDate:'2024-12-31'}}).success).toBe(true);
  expect(recurrenceScheduleInputSchema.safeParse({...schedule,startDate:'2024-01-01',end:{kind:'on_date',endDate:'2025-01-01'}}).success).toBe(false);
  expect(recurrenceScheduleInputSchema.safeParse({...schedule,end:{kind:'on_date',endDate:'2026-10-18'}}).success).toBe(false);
 });
});

describe('recurrence series bound periods',()=>{
 it('returns explicit bound period IDs that agree with the count',()=>{
  expect(recurrenceSeriesSchema.parse(series).boundPeriodIds).toEqual([id(10),id(11)]);
  expect(recurrenceSeriesSchema.safeParse({...series,boundPeriodIds:[],boundPeriodCount:0}).success).toBe(true);
  expect(recurrenceSeriesSchema.safeParse({...series,boundPeriodCount:3}).success).toBe(false);
 });
 it('requires the field on fresh output and rejects duplicates or more than 52 periods',()=>{
  const withoutIds=Object.fromEntries(Object.entries(series).filter(([key])=>key!=='boundPeriodIds'));
  expect(recurrenceSeriesSchema.safeParse(withoutIds).success).toBe(false);
  expect(recurrenceSeriesSchema.safeParse({...series,boundPeriodIds:[id(10),id(10)]}).success).toBe(false);
  const many=Array.from({length:53},(_,i)=>id(100+i));
  expect(recurrenceSeriesSchema.safeParse({...series,boundPeriodIds:many,boundPeriodCount:53}).success).toBe(false);
 });
});
