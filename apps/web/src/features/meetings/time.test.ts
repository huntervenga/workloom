import { describe, expect, it } from 'vitest';
import { clockChoice, meetingDraftInstant, meetingLocal, resolveMeetingClock } from './time';
describe('explicit meeting wall-time resolution',()=>{
 it('rejects a DST gap instead of normalizing the start',()=>expect(resolveMeetingClock('2026-03-29T02:30','Europe/Berlin')).toMatchObject({kind:'invalid'}));
 it('exposes both overlap instants and requires an explicit choice for a changed time',()=>{
  expect(resolveMeetingClock('2026-10-25T02:30','Europe/Berlin')).toMatchObject({kind:'overlap',earlier:'2026-10-25T00:30:00.000Z',later:'2026-10-25T01:30:00.000Z'});
  expect(meetingDraftInstant('2026-10-25T02:30','Europe/Berlin','','2026-10-24T01:30:00.000Z','Europe/Berlin')).toBeNull();
  expect(meetingDraftInstant('2026-10-25T02:30','Europe/Berlin','later','2026-10-24T01:30:00.000Z','Europe/Berlin')).toBe('2026-10-25T01:30:00.000Z');
 });
 it('preserves the exact instant during metadata-only edits, including seconds and the later offset',()=>{
  const instant='2026-10-25T01:30:42.123Z';
  expect(clockChoice(instant,'Europe/Berlin')).toBe('later');
  expect(meetingDraftInstant(meetingLocal(instant,'Europe/Berlin'),'Europe/Berlin',clockChoice(instant,'Europe/Berlin'),instant,'Europe/Berlin')).toBe(instant);
 });
 it('changes only the overlap offset explicitly while retaining existing seconds',()=>{expect(meetingDraftInstant('2026-10-25T02:30','Europe/Berlin','earlier','2026-10-25T01:30:42.123Z','Europe/Berlin')).toBe('2026-10-25T00:30:42.123Z');});
 it('rejects an invalid zone without guessing the browser zone',()=>expect(resolveMeetingClock('2026-10-19T09:00','Not/A_Zone')).toMatchObject({kind:'invalid'}));
});
