import {describe,expect,it} from 'vitest';
import {Temporal} from 'temporal-polyfill';
import {RECURRENCE_DST_REFERENCE_VECTORS,RECURRENCE_RESOLUTION_POLICY,recurrenceResolutionSchema} from '@workloom/contracts';
import type {RecurrenceScheduleInput} from '@workloom/contracts';
import {RECURRENCE_RESOLVER_IMPLEMENTATION,buildRecurrenceScheduleSegments,createRecurrenceOccurrenceResolver} from './schedule.js';
import type {RecurrenceScheduleVersionInput} from './schedule.js';
import type {RecurrenceScheduleSegment} from './ports.js';

const id=(n:number)=>`abcdef00-0000-4000-8000-${String(n).padStart(12,'0')}`;
const resolver=createRecurrenceOccurrenceResolver();
const rejected=(reason:string)=>expect.objectContaining({code:'DOMAIN_VALIDATION_FAILED',details:expect.objectContaining({reason})});
const schedule=(patch:Partial<RecurrenceScheduleInput>):RecurrenceScheduleInput=>({startDate:'2026-10-01',localTime:'09:00',timezone:'Asia/Nicosia',frequency:'daily',plannedDurationMinutes:30,end:{kind:'on_date',endDate:'2026-10-31'},...patch});
const segment=(n:number,from:string,until:string|null,patch:Partial<RecurrenceScheduleInput>={}):RecurrenceScheduleSegment=>({versionId:id(n),effectiveFromNominalDate:from,effectiveUntilExclusive:until,schedule:schedule(patch)});
const keys=(segments:RecurrenceScheduleSegment[])=>resolver.enumerateNominalCandidates(segments).map(c=>c.occurrenceKey);
const elapsedMinutes=(start:string,end:string)=>Temporal.Instant.from(start).until(Temporal.Instant.from(end),{largestUnit:'minutes'}).minutes;

describe('first_valid_gap_earlier_overlap_v1 resolution',()=>{
 it.each(RECURRENCE_DST_REFERENCE_VECTORS)('matches the root reference vector $timezone $intendedLocalDate $intendedLocalTime',vector=>{
  const result=resolver.resolveOccurrence(vector.intendedLocalDate,vector.intendedLocalTime,vector.timezone,45);
  expect(recurrenceResolutionSchema.parse(result)).toEqual(result);
  expect(result).toMatchObject({policyVersion:RECURRENCE_RESOLUTION_POLICY,intendedLocalDate:vector.intendedLocalDate,intendedLocalTime:vector.intendedLocalTime,resolvedLocalDate:vector.resolvedLocalDate,resolvedLocalTime:vector.resolvedLocalTime,resolvedOffset:vector.resolvedOffset,warning:vector.warning,plannedDurationMinutes:45});
  expect(Temporal.Instant.from(result.resolvedStartAt).equals(Temporal.Instant.from(`${vector.resolvedLocalDate}T${vector.resolvedLocalTime}:00${vector.resolvedOffset}`))).toBe(true);
  expect(elapsedMinutes(result.resolvedStartAt,result.resolvedEndAt)).toBe(45);
 });
 it('pins exact instants: first valid boundary, not a compatible shift by the gap size',()=>{
  expect(resolver.resolveOccurrence('2026-03-29','03:30','Asia/Nicosia',60).resolvedStartAt).toBe('2026-03-29T01:00:00.000Z');
  for(const time of ['02:00','02:30','02:59'])expect(resolver.resolveOccurrence('2026-03-08',time,'America/New_York',60)).toMatchObject({resolvedStartAt:'2026-03-08T07:00:00.000Z',resolvedLocalTime:'03:00',warning:'gap_first_valid'});
  expect(resolver.resolveOccurrence('2026-03-08','03:00','America/New_York',60)).toMatchObject({resolvedStartAt:'2026-03-08T07:00:00.000Z',warning:null});
  expect(resolver.resolveOccurrence('2026-03-08','01:59','America/New_York',60)).toMatchObject({resolvedOffset:'-05:00',warning:null});
  expect(resolver.resolveOccurrence('2026-10-04','02:15','Australia/Lord_Howe',60).resolvedStartAt).toBe('2026-10-03T15:30:00.000Z');
  expect(resolver.resolveOccurrence('2026-03-29','03:30','UTC',60)).toMatchObject({resolvedStartAt:'2026-03-29T03:30:00.000Z',resolvedEndAt:'2026-03-29T04:30:00.000Z',resolvedOffset:'+00:00',warning:null});
 });
 it('takes the earlier overlap instant and measures the end in elapsed minutes across the transition',()=>{
  const repeated=resolver.resolveOccurrence('2026-11-01','01:30','America/New_York',60);
  expect(repeated).toMatchObject({resolvedStartAt:'2026-11-01T05:30:00.000Z',resolvedEndAt:'2026-11-01T06:30:00.000Z',resolvedOffset:'-04:00',warning:'ambiguous_earlier'});
  const lordHowe=resolver.resolveOccurrence('2026-04-05','01:45','Australia/Lord_Howe',30);
  expect(lordHowe).toMatchObject({resolvedStartAt:'2026-04-04T14:45:00.000Z',resolvedEndAt:'2026-04-04T15:15:00.000Z',resolvedOffset:'+11:00'});
  const springDay=resolver.resolveOccurrence('2026-03-29','00:30','Asia/Nicosia',1440);
  expect(springDay).toMatchObject({resolvedStartAt:'2026-03-28T22:30:00.000Z',resolvedEndAt:'2026-03-29T22:30:00.000Z',resolvedOffset:'+02:00',warning:null});
 });
 it('moves a wholly skipped date to the next-day boundary and keeps two colliding nominal keys distinct',()=>{
  for(const time of ['00:00','09:00','23:59'])expect(resolver.resolveOccurrence('2011-12-30',time,'Pacific/Apia',60)).toMatchObject({intendedLocalDate:'2011-12-30',intendedLocalTime:time,resolvedLocalDate:'2011-12-31',resolvedLocalTime:'00:00',resolvedStartAt:'2011-12-30T10:00:00.000Z',resolvedOffset:'+14:00',warning:'skipped_local_date'});
  const skipped=resolver.resolveOccurrence('2011-12-30','00:00','Pacific/Apia',60),next=resolver.resolveOccurrence('2011-12-31','00:00','Pacific/Apia',60);
  expect(next).toMatchObject({resolvedStartAt:skipped.resolvedStartAt,warning:null});
  expect(next.intendedLocalDate).not.toBe(skipped.intendedLocalDate);
  expect(resolver.resolveOccurrence('2011-12-29','23:59','Pacific/Apia',60)).toMatchObject({resolvedOffset:'-10:00',warning:null});
 });
 it('rejects unsupported dates, times, zones and durations instead of normalizing them',()=>{
  for(const [date,reason] of [['2026-02-30','invalid_date'],['2026-02-29','invalid_date'],['2026-2-03','invalid_date'],['1999-12-31','date_out_of_range'],['2101-01-01','date_out_of_range']] as const)expect(()=>resolver.resolveOccurrence(date,'09:00','UTC',30)).toThrow(rejected(reason));
  expect(resolver.resolveOccurrence('2000-01-01','00:00','Asia/Tokyo',30)).toMatchObject({resolvedStartAt:'1999-12-31T15:00:00.000Z',resolvedLocalDate:'2000-01-01'});
  expect(resolver.resolveOccurrence('2100-12-31','23:59','UTC',1).resolvedEndAt).toBe('2101-01-01T00:00:00.000Z');
  for(const time of ['24:00','9:00','09:00:00','09:60'])expect(()=>resolver.resolveOccurrence('2026-10-16',time,'UTC',30)).toThrow(rejected('invalid_time'));
  for(const zone of ['+03:00','-05:00','Mars/Olympus','',`A${'b'.repeat(100)}`])expect(()=>resolver.resolveOccurrence('2026-10-16','09:00',zone,30)).toThrow(rejected('invalid_timezone'));
  for(const minutes of [0,1441,1.5,Number.NaN])expect(()=>resolver.resolveOccurrence('2026-10-16','09:00','UTC',minutes)).toThrow(rejected('invalid_duration'));
 });
 it('records injected runtime provenance without reading process metadata',()=>{
  expect(RECURRENCE_RESOLVER_IMPLEMENTATION).toBe('temporal-polyfill@1.0.6');
  expect(resolver.policyVersion).toBe(RECURRENCE_RESOLUTION_POLICY);
  expect(resolver.provenance('Asia/Nicosia')).toEqual({timezone:'Asia/Nicosia',implementation:'temporal-polyfill@1.0.6',tzdataVersion:null,icuVersion:null});
  const pinned=createRecurrenceOccurrenceResolver({tzdataVersion:'2026b',icuVersion:'78.3'});
  expect(pinned.resolveOccurrence('2026-03-29','03:30','Asia/Nicosia',30).provenance).toEqual({timezone:'Asia/Nicosia',implementation:'temporal-polyfill@1.0.6',tzdataVersion:'2026b',icuVersion:'78.3'});
  expect(()=>createRecurrenceOccurrenceResolver({tzdataVersion:'',icuVersion:null})).toThrow(TypeError);
  expect(()=>resolver.provenance('+02:00')).toThrow(rejected('invalid_timezone'));
 });
});

describe('nominal calendar enumeration',()=>{
 it('walks calendar dates across DST, leap days and the non-leap year 2100',()=>{
  expect(keys([segment(1,'2026-03-27',null,{startDate:'2026-03-27',end:{kind:'on_date',endDate:'2026-03-31'}})])).toEqual(['2026-03-27','2026-03-28','2026-03-29','2026-03-30','2026-03-31']);
  expect(keys([segment(1,'2028-02-27',null,{startDate:'2028-02-27',end:{kind:'on_date',endDate:'2028-03-01'}})])).toEqual(['2028-02-27','2028-02-28','2028-02-29','2028-03-01']);
  expect(keys([segment(1,'2100-02-27',null,{startDate:'2100-02-27',end:{kind:'on_date',endDate:'2100-03-01'}})])).toEqual(['2100-02-27','2100-02-28','2100-03-01']);
  expect(keys([segment(1,'2011-12-29',null,{startDate:'2011-12-29',timezone:'Pacific/Apia',end:{kind:'on_date',endDate:'2011-12-31'}})])).toEqual(['2011-12-29','2011-12-30','2011-12-31']);
 });
 it('uses ISO weekdays (7 = Sunday) and an inclusive end date',()=>{
  const weekly=resolver.enumerateNominalCandidates([segment(1,'2026-10-14',null,{startDate:'2026-10-14',frequency:'weekly',weekdays:[7,1],end:{kind:'on_date',endDate:'2026-10-26'}})]);
  expect(weekly).toEqual(['2026-10-18','2026-10-19','2026-10-25','2026-10-26'].map(occurrenceKey=>({occurrenceKey,nominalSequence:null,sourceVersionId:id(1)})));
  expect(keys([segment(1,'2026-10-16',null,{startDate:'2026-10-16',end:{kind:'on_date',endDate:'2026-10-16'}})])).toEqual(['2026-10-16']);
  expect(keys([segment(1,'2026-10-16',null,{startDate:'2026-10-16',frequency:'weekly',weekdays:[1],end:{kind:'on_date',endDate:'2026-10-18'}})])).toEqual([]);
 });
 it('bounds on_date spans to 366 nominal days, including a leap year',()=>{
  expect(keys([segment(1,'2028-01-01',null,{startDate:'2028-01-01',end:{kind:'on_date',endDate:'2028-12-31'}})])).toHaveLength(366);
  expect(()=>resolver.enumerateNominalCandidates([segment(1,'2027-01-01',null,{startDate:'2027-01-01',end:{kind:'on_date',endDate:'2028-01-02'}})])).toThrow(rejected('on_date_span_exceeded'));
  expect(()=>resolver.enumerateNominalCandidates([segment(1,'2026-10-16',null,{startDate:'2026-10-16',end:{kind:'on_date',endDate:'2026-10-15'}})])).toThrow(rejected('on_date_span_exceeded'));
 });
 it('numbers the immutable after_count budget and scans calendar dates, never truncating',()=>{
  const counted=resolver.enumerateNominalCandidates([segment(1,'2026-10-14',null,{startDate:'2026-10-14',frequency:'weekly',weekdays:[5,1,3],end:{kind:'after_count',count:5}})]);
  expect(counted).toEqual([['2026-10-14',1],['2026-10-16',2],['2026-10-19',3],['2026-10-21',4],['2026-10-23',5]].map(([occurrenceKey,nominalSequence])=>({occurrenceKey,nominalSequence,sourceVersionId:id(1)})));
  const daily=keys([segment(1,'2028-01-01',null,{startDate:'2028-01-01',end:{kind:'after_count',count:366}})]);
  expect(daily).toHaveLength(366);expect(daily.at(-1)).toBe('2028-12-31');
  const sparse=keys([segment(1,'2026-10-16',null,{startDate:'2026-10-16',frequency:'weekly',weekdays:[4],end:{kind:'after_count',count:366}})]);
  expect(sparse).toHaveLength(366);expect(sparse[0]).toBe('2026-10-22');
  expect(()=>resolver.enumerateNominalCandidates([segment(1,'2100-12-25',null,{startDate:'2100-12-25',end:{kind:'after_count',count:10}})])).toThrow(rejected('date_out_of_range'));
  for(const count of [0,367,2.5])expect(()=>resolver.enumerateNominalCandidates([segment(1,'2026-10-16',null,{startDate:'2026-10-16',end:{kind:'after_count',count}})])).toThrow(rejected('invalid_count'));
 });
 it('keeps original nominal identity across this-and-future on_date versions',()=>{
  const original=resolver.enumerateNominalCandidates([segment(1,'2026-10-01',null)]);
  const edited=resolver.enumerateNominalCandidates([segment(1,'2026-10-01','2026-10-10'),segment(2,'2026-10-10',null,{frequency:'weekly',weekdays:[1],end:{kind:'on_date',endDate:'2026-11-03'},localTime:'10:00'})]);
  expect(edited.slice(0,9)).toEqual(original.slice(0,9));
  expect(edited.slice(9)).toEqual(['2026-10-12','2026-10-19','2026-10-26','2026-11-02'].map(occurrenceKey=>({occurrenceKey,nominalSequence:null,sourceVersionId:id(2)})));
  const shortened=keys([segment(1,'2026-10-01','2026-10-05'),segment(2,'2026-10-05',null,{end:{kind:'on_date',endDate:'2026-10-03'}})]);
  expect(shortened).toEqual(['2026-10-01','2026-10-02','2026-10-03','2026-10-04']);
 });
 it('labels after_count positions by version without moving or extending the original sequence',()=>{
  const base:Partial<RecurrenceScheduleInput>={end:{kind:'after_count',count:6}};
  const original=resolver.enumerateNominalCandidates([segment(1,'2026-10-01',null,base)]);
  const edited=resolver.enumerateNominalCandidates([segment(1,'2026-10-01','2026-10-04',base),segment(2,'2026-10-04','2026-10-05',{...base,localTime:'11:00',timezone:'UTC'}),segment(3,'2026-10-05',null,{...base,plannedDurationMinutes:90})]);
  expect(edited.map(({occurrenceKey,nominalSequence})=>[occurrenceKey,nominalSequence])).toEqual(original.map(({occurrenceKey,nominalSequence})=>[occurrenceKey,nominalSequence]));
  expect(edited.map(c=>c.sourceVersionId)).toEqual([id(1),id(1),id(1),id(2),id(3),id(3)]);
  const weekly:Partial<RecurrenceScheduleInput>={frequency:'weekly',weekdays:[1,3],end:{kind:'after_count',count:3}};
  expect(keys([segment(1,'2026-10-01','2026-10-06',weekly),segment(2,'2026-10-06',null,{...weekly,weekdays:[3,1]})])).toEqual(['2026-10-05','2026-10-07','2026-10-12']);
  for(const patch of [{end:{kind:'after_count',count:7}},{frequency:'weekly',weekdays:[1]},{end:{kind:'on_date',endDate:'2026-12-31'}},{startDate:'2026-10-04'}] as Partial<RecurrenceScheduleInput>[])
   expect(()=>resolver.enumerateNominalCandidates([segment(1,'2026-10-01','2026-10-04',base),segment(2,'2026-10-04',null,{...base,...patch})])).toThrow(expect.objectContaining({code:'DOMAIN_VALIDATION_FAILED'}));
 });
 it('rejects malformed, overlapping, gapped or closed version segments',()=>{
  expect(()=>resolver.enumerateNominalCandidates([])).toThrow(rejected('segments_empty'));
  expect(()=>resolver.enumerateNominalCandidates([segment(1,'2026-10-02',null)])).toThrow(rejected('segments_not_contiguous'));
  expect(()=>resolver.enumerateNominalCandidates([segment(1,'2026-10-01','2026-10-05'),segment(2,'2026-10-06',null)])).toThrow(rejected('segments_not_contiguous'));
  expect(()=>resolver.enumerateNominalCandidates([segment(1,'2026-10-01','2026-10-05'),segment(2,'2026-10-04',null)])).toThrow(rejected('segments_not_contiguous'));
  expect(()=>resolver.enumerateNominalCandidates([segment(1,'2026-10-01','2026-10-01'),segment(2,'2026-10-01',null)])).toThrow(rejected('segments_not_contiguous'));
  expect(()=>resolver.enumerateNominalCandidates([segment(1,'2026-10-01','2026-10-31')])).toThrow(rejected('segments_not_contiguous'));
  expect(()=>resolver.enumerateNominalCandidates([segment(1,'2026-10-01','2026-10-05'),{...segment(2,'2026-10-05',null),versionId:id(1).toUpperCase()}])).toThrow(rejected('duplicate_version'));
  expect(()=>resolver.enumerateNominalCandidates([segment(1,'2026-10-01',null,{frequency:'weekly',weekdays:[1,1]})])).toThrow(rejected('invalid_weekdays'));
  expect(()=>resolver.enumerateNominalCandidates([segment(1,'2026-10-01',null,{frequency:'weekly',weekdays:[0]})])).toThrow(rejected('invalid_weekdays'));
  expect(()=>resolver.enumerateNominalCandidates([segment(1,'2026-10-01',null,{weekdays:[1]})])).toThrow(rejected('invalid_weekdays'));
  expect(()=>resolver.enumerateNominalCandidates([segment(1,'1999-12-31',null,{startDate:'1999-12-31'})])).toThrow(rejected('date_out_of_range'));
  expect(()=>resolver.enumerateNominalCandidates([segment(1,'2026-10-01','2026-10-05'),segment(2,'2026-10-05',null,{end:{kind:'after_count',count:3}})])).toThrow(rejected('end_kind_changed'));
 });
});

describe('segments from immutable version history',()=>{
 const version=(n:number,revision:number,from:string,patch:Partial<RecurrenceScheduleInput>={}):RecurrenceScheduleVersionInput=>({id:id(n),revision,effectiveFromNominalDate:from,schedule:schedule(patch)});
 const shape=(versions:RecurrenceScheduleVersionInput[])=>buildRecurrenceScheduleSegments(versions).map(s=>[s.versionId,s.effectiveFromNominalDate,s.effectiveUntilExclusive]);
 it('lets a newer earlier-effective edit supersede an older scheduled future version',()=>{
  const v1=version(1,1,'2026-10-01'),v2=version(2,2,'2026-10-20',{localTime:'11:00'}),v3=version(3,3,'2026-10-18',{localTime:'10:00'});
  const segments=buildRecurrenceScheduleSegments([v1,v2,v3]);
  expect(segments).toEqual([{versionId:id(1),effectiveFromNominalDate:'2026-10-01',effectiveUntilExclusive:'2026-10-18',schedule:v1.schedule},{versionId:id(3),effectiveFromNominalDate:'2026-10-18',effectiveUntilExclusive:null,schedule:v3.schedule}]);
  const byKey=new Map(resolver.enumerateNominalCandidates(segments).map(c=>[c.occurrenceKey,c.sourceVersionId]));
  expect([byKey.get('2026-10-17'),byKey.get('2026-10-18'),byKey.get('2026-10-20'),byKey.get('2026-10-31')]).toEqual([id(1),id(3),id(3),id(3)]);
  expect(byKey.size).toBe(31);
  expect(shape([v1,version(2,2,'2026-10-18'),version(3,3,'2026-10-20')])).toEqual([[id(1),'2026-10-01','2026-10-18'],[id(2),'2026-10-18','2026-10-20'],[id(3),'2026-10-20',null]]);
 });
 it('picks the highest numeric revision on a shared boundary, never the lexicographic ID',()=>{
  expect(shape([version(1,1,'2026-10-01'),version(2,2,'2026-10-20'),version(3,3,'2026-10-20')])).toEqual([[id(1),'2026-10-01','2026-10-20'],[id(3),'2026-10-20',null]]);
  expect(shape([version(9,1,'2026-10-01'),version(8,2,'2026-10-20'),version(1,10,'2026-10-20')])).toEqual([[id(9),'2026-10-01','2026-10-20'],[id(1),'2026-10-20',null]]);
  expect(shape([version(1,1,'2026-10-01'),version(2,2,'2026-10-01')])).toEqual([[id(2),'2026-10-01',null]]);
 });
 it('is stable for unmodified records regardless of input order',()=>{
  const versions=[version(1,1,'2026-10-01'),version(2,2,'2026-10-20',{frequency:'weekly',weekdays:[1,4]}),version(3,3,'2026-10-18',{frequency:'weekly',weekdays:[2]}),version(4,4,'2026-10-25')];
  const expected=resolver.enumerateNominalCandidates(buildRecurrenceScheduleSegments(versions));
  const [v1,v2,v3,v4]=versions;
  if(v1===undefined||v2===undefined||v3===undefined||v4===undefined)throw new Error('Expected four versions.');
  for(const order of [[v4,v2,v1,v3],[v3,v4,v2,v1],[v1,v2,v3,v4]])expect(resolver.enumerateNominalCandidates(buildRecurrenceScheduleSegments(order))).toEqual(expected);
  expect(expected.filter(c=>c.sourceVersionId===id(3)).map(c=>c.occurrenceKey)).toEqual(['2026-10-20']);
  expect(expected.filter(c=>c.sourceVersionId===id(2))).toEqual([]);
 });
 it('never resets or extends the initial after_count budget, even through superseded versions',()=>{
  const base:Partial<RecurrenceScheduleInput>={end:{kind:'after_count',count:6}};
  const original=resolver.enumerateNominalCandidates(buildRecurrenceScheduleSegments([version(1,1,'2026-10-01',base)]));
  const edited=resolver.enumerateNominalCandidates(buildRecurrenceScheduleSegments([version(1,1,'2026-10-01',base),version(2,2,'2026-10-03',{...base,localTime:'11:00'}),version(3,3,'2026-10-04',{...base,timezone:'UTC'}),version(4,4,'2026-10-02',{...base,plannedDurationMinutes:60})]));
  expect(edited.map(({occurrenceKey,nominalSequence})=>[occurrenceKey,nominalSequence])).toEqual(original.map(({occurrenceKey,nominalSequence})=>[occurrenceKey,nominalSequence]));
  expect(edited.map(c=>c.sourceVersionId)).toEqual([id(1),id(4),id(4),id(4),id(4),id(4)]);
  expect(()=>buildRecurrenceScheduleSegments([version(1,1,'2026-10-01',base),version(2,2,'2026-10-20',{end:{kind:'after_count',count:10}}),version(3,3,'2026-10-05',base)])).toThrow(rejected('after_count_sequence_immutable'));
  expect(()=>buildRecurrenceScheduleSegments([version(1,1,'2026-10-01',base),version(2,2,'2026-10-20',{...base,startDate:'2026-10-02'}),version(3,3,'2026-10-05',base)])).toThrow(rejected('start_date_changed'));
  expect(()=>buildRecurrenceScheduleSegments([version(1,1,'2026-10-01'),version(2,2,'2026-10-20',base),version(3,3,'2026-10-05')])).toThrow(rejected('end_kind_changed'));
 });
 it('rejects ambiguous or invalid version records',()=>{
  expect(()=>buildRecurrenceScheduleSegments([])).toThrow(rejected('segments_empty'));
  expect(()=>buildRecurrenceScheduleSegments([version(1,1,'2026-10-01'),{...version(2,2,'2026-10-05'),id:id(1).toUpperCase()}])).toThrow(rejected('duplicate_version'));
  expect(()=>buildRecurrenceScheduleSegments([version(1,2,'2026-10-01'),version(2,2,'2026-10-05')])).toThrow(rejected('duplicate_revision'));
  for(const revision of [0,-1,1.5,Number.NaN])expect(()=>buildRecurrenceScheduleSegments([version(1,revision,'2026-10-01')])).toThrow(rejected('invalid_revision'));
  expect(()=>buildRecurrenceScheduleSegments([{...version(1,1,'2026-10-01'),id:''}])).toThrow(rejected('invalid_version'));
  expect(()=>buildRecurrenceScheduleSegments([version(1,1,'2026-10-02')])).toThrow(rejected('segments_not_contiguous'));
  expect(()=>buildRecurrenceScheduleSegments([version(1,1,'2026-10-01'),version(2,2,'2026-09-30')])).toThrow(rejected('segments_not_contiguous'));
  expect(()=>buildRecurrenceScheduleSegments([version(1,1,'2026-10-01'),version(2,2,'2026-02-30')])).toThrow(rejected('invalid_date'));
 });
});
