import type * as C from '@workloom/contracts';
import { DomainError, notFoundError } from '../errors.js';
import { canonicalJson } from '../tasks/service.js';
import { calculateAvailability } from './calculation.js';
import { dateRange, isNonworkingHoliday } from './calendar.js';
import type { LeaveStoredSource } from './ports.js';
/** Neutral capacity only: notes, balance types and request reasons never leave this projection. */
export function buildLeaveAvailability(stored:LeaveStoredSource,input:C.LeaveAvailabilityInput,manager:boolean,digest:(s:string)=>string):C.LeaveAvailabilityDto {
 const members=input.people.kind==='all_active'?stored.members.filter(m=>m.state==='active'):input.people.membershipIds.map(id=>{
  const member=stored.members.find(m=>m.id===id&&(manager||m.state==='active'));if(!member)throw notFoundError();return member;
 });
 if(members.length>100)throw new DomainError('DOMAIN_VALIDATION_FAILED','Choose at most 100 people for capacity.');
 const ids=new Set(members.map(m=>m.id)),profiles=stored.profiles.filter(p=>ids.has(p.membershipId));
 const requests=stored.requests.filter(r=>ids.has(r.membershipId)&&r.status==='approved'&&r.capacityUnavailable&&r.startDate<=input.endDate&&r.endDate>=input.startDate);
 const settings=stored.settings,configured=settings!==null;
 const days=settings?calculateAvailability({settings,profiles,requests,adjustments:[]},{startDate:input.startDate,endDate:input.endDate,membershipIds:profiles.map(p=>p.membershipId)}):[];
 const result={startDate:input.startDate,endDate:input.endDate,settingsConfigured:configured,days,
  members:members.map(member=>{const known=configured&&profiles.some(p=>p.membershipId===member.id),selected=days.filter(d=>d.membershipId===member.id);const sum=(key:'scheduledMinutes'|'holidayMinutes'|'absenceMinutes'|'availableMinutes')=>known?selected.reduce((n,d)=>n+d[key],0):null;return {membershipId:member.id,displayName:member.displayName,scheduleKnown:known,scheduledMinutes:sum('scheduledMinutes'),holidayMinutes:sum('holidayMinutes'),absenceMinutes:sum('absenceMinutes'),availableMinutes:sum('availableMinutes')};}),
  totals:{scheduledMinutes:days.reduce((n,d)=>n+d.scheduledMinutes,0),holidayMinutes:days.reduce((n,d)=>n+d.holidayMinutes,0),absenceMinutes:days.reduce((n,d)=>n+d.absenceMinutes,0),availableMinutes:days.reduce((n,d)=>n+d.availableMinutes,0),unconfiguredMembers:members.filter(m=>!configured||!profiles.some(p=>p.membershipId===m.id)).length},
  intervals:requests.filter(r=>r.capacityUnavailable&&r.startDate<=input.endDate&&r.endDate>=input.startDate).map(r=>({membershipId:r.membershipId,startDate:r.startDate<input.startDate?input.startDate:r.startDate,endDate:r.endDate>input.endDate?input.endDate:r.endDate})),
  companyHolidays:settings?dateRange(input.startDate,input.endDate,366).filter(d=>isNonworkingHoliday(settings,d)):[],
  inputVersions:{settingsRevision:stored.settings?.revision??0,profiles:[],requests:[],digest:digest(canonicalJson({settingsRevision:stored.settings?.revision??0,days,intervals:requests.map(r=>({membershipId:r.membershipId,startDate:r.startDate<input.startDate?input.startDate:r.startDate,endDate:r.endDate>input.endDate?input.endDate:r.endDate}))}))},
 };
 return {...result,sourceVersion:digest(canonicalJson(result))};
}
