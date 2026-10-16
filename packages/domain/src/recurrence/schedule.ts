import {Temporal} from 'temporal-polyfill';
import {RECURRENCE_LIMITS,RECURRENCE_RESOLUTION_POLICY} from '@workloom/contracts';
import type {RecurrenceResolutionDto,RecurrenceResolutionWarning,RecurrenceScheduleInput,RecurrenceTimezoneProvenance} from '@workloom/contracts';
import {DomainError} from '../errors.js';
import type {RecurrenceNominalCandidate,RecurrenceOccurrenceResolver,RecurrenceScheduleSegment} from './ports.js';

/** Pure P3b enumeration and resolution (docs/16-p3b-contract.md §3, §6). Calendar-date arithmetic only,
 * never UTC +24h. Every rejection is a 422; nothing is rounded, truncated or silently clamped.
 */
export const RECURRENCE_RESOLVER_IMPLEMENTATION='temporal-polyfill@1.0.6' as const;
/** Runtime tz/ICU versions are process metadata: the composition root injects them, the domain never reads process. */
export interface RecurrenceResolverRuntime {readonly tzdataVersion:string|null;readonly icuVersion:string|null}

// Supported range (docs16 §0 п.11), checked here independently of the contract schemas.
const MIN_DATE='2000-01-01',MAX_DATE='2100-12-31';
const MINUTE_NS=60_000_000_000;
/** Transitions inspected between the earlier/later candidates; real gaps/overlaps contain one. */
const MAX_TRANSITION_PROBES=4;

function rejected(message:string,field:string,reason:string):DomainError{
 return new DomainError('DOMAIN_VALIDATION_FAILED',message,{details:{fields:[field],reason}});
}
const unrepresentable=(field:string)=>rejected('The local time cannot be represented at whole-minute precision in this time zone.',field,'unsupported_transition');

function calendarDate(value:unknown,field:string):Temporal.PlainDate{
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))throw rejected('Expected a YYYY-MM-DD date.',field,'invalid_date');
 let date:Temporal.PlainDate;
 try{date=Temporal.PlainDate.from(value,{overflow:'reject'});}catch{throw rejected('Expected a YYYY-MM-DD date.',field,'invalid_date');}
 if(date.toString()!==value)throw rejected('Expected a YYYY-MM-DD date.',field,'invalid_date');
 if(value<MIN_DATE||value>MAX_DATE)throw rejected(`Recurrence dates must be between ${MIN_DATE} and ${MAX_DATE}.`,field,'date_out_of_range');
 return date;
}
function localTime(value:unknown,field:string):Temporal.PlainTime{
 if(typeof value!=='string'||!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(value))throw rejected('Expected HH:mm.',field,'invalid_time');
 return Temporal.PlainTime.from(value);
}
function timeZone(value:unknown,field='timezone'):string{
 if(typeof value!=='string'||value.length<1||value.length>100||/^[+-]/.test(value))throw rejected('Expected an IANA time zone.',field,'invalid_timezone');
 try{Temporal.PlainDate.from(MIN_DATE).toZonedDateTime(value);}catch{throw rejected('Expected an IANA time zone.',field,'invalid_timezone');}
 return value;
}
function durationMinutes(value:unknown):number{
 if(typeof value!=='number'||!Number.isInteger(value)||value<1||value>RECURRENCE_LIMITS.maxDurationMinutes)throw rejected(`Duration must be 1–${RECURRENCE_LIMITS.maxDurationMinutes} minutes.`,'plannedDurationMinutes','invalid_duration');
 return value;
}
function runtimeVersion(value:string|null,name:string):string|null{
 if(value!==null&&(typeof value!=='string'||value.length<1||value.length>40))throw new TypeError(`Invalid ${name} runtime version.`);
 return value;
}

const pad=(value:number)=>String(value).padStart(2,'0');
const hhmm=(value:Temporal.ZonedDateTime)=>`${pad(value.hour)}:${pad(value.minute)}`;
const instantText=(value:Temporal.Instant)=>value.toString({smallestUnit:'millisecond'});
const wallCompare=(a:Temporal.ZonedDateTime,b:Temporal.PlainDateTime)=>Temporal.PlainDateTime.compare(a.toPlainDateTime(),b);
function requireMinuteOffset(value:Temporal.ZonedDateTime,field:string):void{
 if(value.offsetNanoseconds%MINUTE_NS!==0||!/^[+-]([01][0-9]|2[0-3]):[0-5][0-9]$/.test(value.offset))throw unrepresentable(field);
}
function requireMinuteTransition(before:Temporal.ZonedDateTime,boundary:Temporal.ZonedDateTime,field:string):void{
 requireMinuteOffset(before,field);requireMinuteOffset(boundary,field);
 if(boundary.second!==0||boundary.millisecond!==0||boundary.microsecond!==0||boundary.nanosecond!==0)throw unrepresentable(field);
}

/** The transition strictly after `earlier` and at or before `later` that satisfies `accept`, bounded probing. */
function findTransition(earlier:Temporal.ZonedDateTime,later:Temporal.ZonedDateTime,accept:(before:Temporal.ZonedDateTime,boundary:Temporal.ZonedDateTime)=>boolean,field:string){
 let boundary=earlier.getTimeZoneTransition('next');
 for(let probe=0;boundary!==null&&probe<MAX_TRANSITION_PROBES&&Temporal.ZonedDateTime.compare(boundary,later)<=0;probe++){
  const before=boundary.subtract({nanoseconds:1});
  if(accept(before,boundary)){requireMinuteTransition(before,boundary,field);return {before,boundary};}
  boundary=boundary.getTimeZoneTransition('next');
 }
 throw unrepresentable(field);
}

/** first_valid_gap_earlier_overlap_v1: exact → itself; overlap → earlier instant; gap → the first valid local
 * minute at the transition boundary that closes this gap (not a compatible shift by the gap size); a wholly
 * skipped local date → that boundary on a later date, keeping the original nominal date as identity.
 */
function resolveStart(date:Temporal.PlainDate,time:Temporal.PlainTime,zone:string):{start:Temporal.ZonedDateTime;warning:RecurrenceResolutionWarning|null}{
 const wall=date.toPlainDateTime(time);
 const earlier=wall.toZonedDateTime(zone,{disambiguation:'earlier'}),later=wall.toZonedDateTime(zone,{disambiguation:'later'});
 requireMinuteOffset(earlier,'intendedLocalTime');requireMinuteOffset(later,'intendedLocalTime');
 const earlierExact=wallCompare(earlier,wall)===0,laterExact=wallCompare(later,wall)===0;
 if(earlierExact&&laterExact){
  if(earlier.epochNanoseconds===later.epochNanoseconds)return {start:earlier,warning:null};
  // Both sides of the repeated interval must be minute-aligned too; the earlier instant is chosen.
  findTransition(earlier,later,(before,boundary)=>wallCompare(before,wall)>=0&&wallCompare(boundary,wall)<=0,'intendedLocalTime');
  return {start:earlier,warning:'ambiguous_earlier'};
 }
 if(earlierExact||laterExact)throw unrepresentable('intendedLocalTime');
 const {before,boundary}=findTransition(earlier,later,(prior,next)=>wallCompare(prior,wall)<0&&wallCompare(next,wall)>0,'intendedLocalTime');
 const skippedDate=Temporal.PlainDate.compare(before.toPlainDate(),date)<0&&Temporal.PlainDate.compare(boundary.toPlainDate(),date)>0;
 return {start:boundary,warning:skippedDate?'skipped_local_date':'gap_first_valid'};
}

// ---- Nominal enumeration --------------------------------------------------------------------------

interface NormalizedSegment {
 readonly versionId:string;readonly from:string;readonly until:string|null;
 readonly frequency:'daily'|'weekly';readonly weekdays:ReadonlySet<number>|null;readonly end:RecurrenceScheduleInput['end'];
}
/** Checked head of a non-empty list; an empty one is the same 422 as an empty series. */
function firstOf<T>(items:readonly T[],field:string):T{
 const item=items[0];
 if(item===undefined)throw rejected('A series needs at least one schedule version.',field,'segments_empty');
 return item;
}
const weekdayKey=(set:ReadonlySet<number>|null)=>set===null?'':[...set].sort((a,b)=>a-b).join(',');

function normalizeSchedule(schedule:RecurrenceScheduleInput,startDate:string):Pick<NormalizedSegment,'frequency'|'weekdays'|'end'>{
 if(typeof schedule!=='object'||schedule===null)throw rejected('Expected a schedule.','schedule','invalid_schedule');
 if(schedule.startDate!==startDate)throw rejected('All schedule versions keep the immutable series start date.','startDate','start_date_changed');
 const {weekdays,end}=schedule as {weekdays?:unknown;end?:unknown};
 const raw:unknown=schedule.frequency;
 if(raw!=='daily'&&raw!=='weekly')throw rejected('Expected daily or weekly frequency.','frequency','invalid_frequency');
 const frequency=raw as NormalizedSegment['frequency'];
 let days:ReadonlySet<number>|null=null;
 if(frequency==='daily'&&weekdays!==undefined)throw rejected('Daily series take no weekdays.','weekdays','invalid_weekdays');
 if(frequency==='weekly'){
  if(!Array.isArray(weekdays)||weekdays.length<1||weekdays.length>7||!weekdays.every(day=>Number.isInteger(day)&&day>=1&&day<=7))throw rejected('Weekly series need ISO weekdays 1–7.','weekdays','invalid_weekdays');
  days=new Set<number>(weekdays as number[]);
  if(days.size!==weekdays.length)throw rejected('Duplicate weekdays.','weekdays','invalid_weekdays');
 }
 const kind=typeof end==='object'&&end!==null?(end as {kind?:unknown}).kind:undefined;
 if(kind==='on_date'){
  const endDate=calendarDate((end as {endDate?:unknown}).endDate,'end.endDate');
  const span=Temporal.PlainDate.from(startDate).until(endDate,{largestUnit:'days'}).days+1;
  if(span<1||span>RECURRENCE_LIMITS.maxOnDateSpanDays)throw rejected(`End date must be within ${RECURRENCE_LIMITS.maxOnDateSpanDays} calendar days from the start date.`,'end.endDate','on_date_span_exceeded');
  return {frequency,weekdays:days,end:{kind:'on_date',endDate:endDate.toString()}};
 }
 if(kind==='after_count'){
  const count=(end as {count?:unknown}).count;
  if(typeof count!=='number'||!Number.isInteger(count)||count<1||count>RECURRENCE_LIMITS.maxAfterCount)throw rejected(`Count must be 1–${RECURRENCE_LIMITS.maxAfterCount}.`,'end.count','invalid_count');
  return {frequency,weekdays:days,end:{kind:'after_count',count}};
 }
 throw rejected('Expected an on_date or after_count end.','end','invalid_end');
}

/** Non-empty, contiguous, strictly ordered "this and future" segments: the first starts at the series start
 * date and the last stays open. after_count segments share the immutable initial sequence (start, cadence,
 * weekdays, count, end kind); only template/localTime/timezone/duration may differ between versions.
 */
function normalizeSegments(segments:readonly RecurrenceScheduleSegment[]):NormalizedSegment[]{
 if(!Array.isArray(segments)||segments.length===0)throw rejected('A series needs at least one schedule version.','segments','segments_empty');
 const first=firstOf(segments,'segments');
 const startDate=calendarDate((first.schedule as {startDate?:unknown}|null|undefined)?.startDate,'startDate').toString();
 const versionIds=new Set<string>();
 const result:NormalizedSegment[]=[];
 segments.forEach((segment,index)=>{
  if(typeof segment.versionId!=='string'||segment.versionId.length===0)throw rejected('Expected a version ID.','segments','invalid_version');
  const versionKey=segment.versionId.toLowerCase();
  if(versionIds.has(versionKey))throw rejected('Duplicate schedule version.','segments','duplicate_version');
  versionIds.add(versionKey);
  const from=calendarDate(segment.effectiveFromNominalDate,'effectiveFromNominalDate').toString();
  const until=segment.effectiveUntilExclusive===null?null:calendarDate(segment.effectiveUntilExclusive,'effectiveUntilExclusive').toString();
  if(index===0&&from!==startDate)throw rejected('The first schedule version starts at the series start date.','effectiveFromNominalDate','segments_not_contiguous');
  const previous=result[index-1];
  if(previous!==undefined&&previous.until!==from)throw rejected('Schedule versions must be contiguous and non-overlapping.','effectiveFromNominalDate','segments_not_contiguous');
  if(until!==null&&until<=from)throw rejected('A schedule version must cover at least one nominal date.','effectiveUntilExclusive','segments_not_contiguous');
  if(index===segments.length-1&&until!==null)throw rejected('The latest schedule version stays open-ended.','effectiveUntilExclusive','segments_not_contiguous');
  result.push({versionId:segment.versionId,from,until,...normalizeSchedule(segment.schedule,startDate)});
 });
 requireImmutableSequence(result);
 return result;
}
/** The first rule fixes the end kind and, for after_count, the whole nominal sequence (cadence, weekdays, count). */
function requireImmutableSequence(rules:readonly Pick<NormalizedSegment,'frequency'|'weekdays'|'end'>[]):void{
 const head=firstOf(rules,'segments');
 if(head.end.kind==='after_count'){
  const count=head.end.count,days=weekdayKey(head.weekdays);
  for(const rule of rules)if(rule.end.kind!=='after_count'||rule.end.count!==count||rule.frequency!==head.frequency||weekdayKey(rule.weekdays)!==days)throw rejected('The after_count nominal sequence is immutable.','end','after_count_sequence_immutable');
 }else if(rules.some(rule=>rule.end.kind!=='on_date'))throw rejected('The series end kind is immutable.','end','end_kind_changed');
}

export interface RecurrenceScheduleVersionInput {readonly id:string;readonly revision:number;readonly effectiveFromNominalDate:string;readonly schedule:RecurrenceScheduleInput}
/** Canonical non-overlapping segments from the full immutable version history. For every nominal date the
 * version with the highest numeric revision among those with effectiveFromNominalDate <= date wins, so a newer
 * this-and-future edit also supersedes older versions scheduled further in the future, and several versions may
 * share one effective boundary. Fully superseded versions produce no segment but are still validated against the
 * initial (lowest-revision) series: same start date and end kind and, for after_count, the same nominal sequence,
 * so dropping them can never reset or extend the original budget. Input order never matters.
 */
export function buildRecurrenceScheduleSegments(versions:readonly RecurrenceScheduleVersionInput[]):RecurrenceScheduleSegment[]{
 if(!Array.isArray(versions)||versions.length===0)throw rejected('A series needs at least one schedule version.','versions','segments_empty');
 const ids=new Set<string>(),revisions=new Set<number>();
 const ordered=versions.map(version=>{
  if(typeof version.id!=='string'||version.id.length===0)throw rejected('Expected a version ID.','versions','invalid_version');
  if(!Number.isSafeInteger(version.revision)||version.revision<1)throw rejected('Expected a positive integer version revision.','versions','invalid_revision');
  const idKey=version.id.toLowerCase();
  if(ids.has(idKey))throw rejected('Duplicate schedule version.','versions','duplicate_version');
  if(revisions.has(version.revision))throw rejected('Two schedule versions share one revision.','versions','duplicate_revision');
  ids.add(idKey);revisions.add(version.revision);
  return {version,from:calendarDate(version.effectiveFromNominalDate,'effectiveFromNominalDate').toString()};
 }).sort((a,b)=>a.version.revision-b.version.revision);
 const initial=firstOf(ordered,'versions');
 const startDate=calendarDate((initial.version.schedule as {startDate?:unknown}|null|undefined)?.startDate,'startDate').toString();
 if(initial.from!==startDate)throw rejected('The initial schedule version starts at the series start date.','effectiveFromNominalDate','segments_not_contiguous');
 requireImmutableSequence(ordered.map(entry=>{
  if(entry.from<startDate)throw rejected('A schedule version cannot take effect before the series start date.','effectiveFromNominalDate','segments_not_contiguous');
  return normalizeSchedule(entry.version.schedule,startDate);
 }));
 const segments:RecurrenceScheduleSegment[]=[];
 for(const boundary of [...new Set(ordered.map(entry=>entry.from))].sort()){
  // Ascending revision: the last eligible entry has the highest revision. Winners never decrease over dates.
  let winner=initial;
  for(const entry of ordered)if(entry.from<=boundary)winner=entry;
  const last=segments.at(-1);
  if(last?.versionId===winner.version.id)continue;
  if(last!==undefined)segments[segments.length-1]={...last,effectiveUntilExclusive:boundary};
  segments.push({versionId:winner.version.id,effectiveFromNominalDate:boundary,effectiveUntilExclusive:null,schedule:winner.version.schedule});
 }
 return segments;
}
// Weekly rules always carry a weekday set (normalizeSchedule); a missing set never matches.
const occursOn=(segment:Pick<NormalizedSegment,'frequency'|'weekdays'>,date:Temporal.PlainDate)=>segment.frequency==='daily'||segment.weekdays?.has(date.dayOfWeek)===true;

function enumerate(input:readonly RecurrenceScheduleSegment[]):RecurrenceNominalCandidate[]{
 const segments=normalizeSegments(input),head=firstOf(segments,'segments');
 const candidates:RecurrenceNominalCandidate[]=[];
 const keys=new Set<string>();
 // Dates are visited in ascending order, so the governing segment only moves forward.
 let index=0,current=head;
 const governing=(key:string)=>{
  for(let next=segments[index+1];next!==undefined&&next.from<=key;next=segments[index+1]){index++;current=next;}
  return current;
 };
 const push=(key:string,nominalSequence:number|null,sourceVersionId:string)=>{
  if(keys.has(key))return;
  if(candidates.length>=RECURRENCE_LIMITS.maxNominalCandidatesPerSeries)throw rejected(`A series has at most ${RECURRENCE_LIMITS.maxNominalCandidatesPerSeries} nominal occurrences.`,'segments','candidate_limit_exceeded');
  keys.add(key);candidates.push({occurrenceKey:key,nominalSequence,sourceVersionId});
 };
 let date=Temporal.PlainDate.from(head.from);
 if(head.end.kind==='after_count'){
  // Immutable initial budget: positions come from the original rule; versions only label the source.
  const count=head.end.count;
  for(let scanned=0;candidates.length<count;scanned++,date=date.add({days:1})){
   if(scanned>=RECURRENCE_LIMITS.maxAfterCountScanDays)throw rejected(`after_count scans at most ${RECURRENCE_LIMITS.maxAfterCountScanDays} days.`,'end.count','after_count_scan_exceeded');
   const key=date.toString();
   if(key>MAX_DATE)throw rejected(`Recurrence dates must be between ${MIN_DATE} and ${MAX_DATE}.`,'end.count','date_out_of_range');
   if(occursOn(head,date))push(key,candidates.length+1,governing(key).versionId);
  }
  return candidates;
 }
 const lastEnd=segments.reduce((max,segment)=>segment.end.kind==='on_date'&&segment.end.endDate>max?segment.end.endDate:max,head.from);
 for(let key=date.toString();key<=lastEnd;date=date.add({days:1}),key=date.toString()){
  const segment=governing(key);
  if(segment.end.kind==='on_date'&&key<=segment.end.endDate&&occursOn(segment,date))push(key,null,segment.versionId);
 }
 return candidates;
}

export function createRecurrenceOccurrenceResolver(runtime:RecurrenceResolverRuntime={tzdataVersion:null,icuVersion:null}):RecurrenceOccurrenceResolver{
 const tzdataVersion=runtimeVersion(runtime.tzdataVersion,'tzdata'),icuVersion=runtimeVersion(runtime.icuVersion,'ICU');
 const provenance=(timezone:string):RecurrenceTimezoneProvenance=>({timezone:timeZone(timezone),implementation:RECURRENCE_RESOLVER_IMPLEMENTATION,tzdataVersion,icuVersion});
 return {
  policyVersion:RECURRENCE_RESOLUTION_POLICY,
  provenance,
  enumerateNominalCandidates:enumerate,
  resolveOccurrence(nominalDate,time,timezone,plannedDurationMinutes):RecurrenceResolutionDto{
   const date=calendarDate(nominalDate,'intendedLocalDate'),wallTime=localTime(time,'intendedLocalTime'),zone=timeZone(timezone);
   const minutes=durationMinutes(plannedDurationMinutes);
   const {start,warning}=resolveStart(date,wallTime,zone);
   const resolvedLocalDate=start.toPlainDate().toString();
   if(resolvedLocalDate<MIN_DATE||resolvedLocalDate>MAX_DATE)throw rejected(`Recurrence dates must be between ${MIN_DATE} and ${MAX_DATE}.`,'resolvedLocalDate','date_out_of_range');
   const instant=start.toInstant();
   return {
    policyVersion:RECURRENCE_RESOLUTION_POLICY,intendedLocalDate:date.toString(),intendedLocalTime:time,
    resolvedStartAt:instantText(instant),resolvedEndAt:instantText(instant.add({minutes})),
    resolvedLocalDate,resolvedLocalTime:hhmm(start),resolvedOffset:start.offset,plannedDurationMinutes:minutes,
    warning,provenance:provenance(zone),
   };
  },
 };
}
