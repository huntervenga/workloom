import type {LeaveCalculationSource} from '@workloom/contracts';
import {DomainError} from '../errors.js';
import {dateOrdinal} from './calendar.js';
/** Worst-case ten simulation passes cover paid/unpaid preview before/after/projection/debt paths.
 * 16M weighted units admits the measured 7×3 century and 100×30/5k short-history fixtures.
 * This bounds an operation, never the validity of saved dates or business facts. */
export const LEAVE_QUERY_WORK_LIMIT=16_000_000;
export function leaveQueryWork(source:LeaveCalculationSource,through:string,membershipIds?:readonly string[],onlyTypeId?:string,stopAt=Infinity):number {
 const selected=membershipIds?new Set(membershipIds.map(id=>id.toLowerCase())):null,baseTypes=[...new Set(source.settings.policyVersions.flatMap(p=>p.types.filter(t=>t.consumesBalance).map(t=>t.id.toLowerCase())))];
 const events=new Map<string,{count:number;types:Set<string>;horizons:Map<string,string>}>();
 const event=(id:string)=>{const key=id.toLowerCase();let value=events.get(key);if(!value){value={count:0,types:new Set(),horizons:new Map()};events.set(key,value);}return value;};
 for(const r of source.requests){const value=event(r.membershipId);value.count+=1+r.chargedDays.length;if(r.status==='approved'&&r.consumesBalance){const type=r.typeId.toLowerCase();value.types.add(type);let end=value.horizons.get(type)??through;for(const day of r.chargedDays)if(day.date>end)end=day.date;value.horizons.set(type,end);}}
 for(const a of source.adjustments){const value=event(a.membershipId);value.count++;const type=a.typeId.toLowerCase();value.types.add(type);if(a.effectiveDate>(value.horizons.get(type)??through))value.horizons.set(type,a.effectiveDate);}
 const ordinals=new Map<string,number>(),ordinal=(date:string)=>{let n=ordinals.get(date);if(n===undefined){n=dateOrdinal(date);ordinals.set(date,n);}return n;};let work=0;
 for(const p of source.profiles){const id=p.membershipId.toLowerCase();if(selected&&!selected.has(id))continue;const value=events.get(id),types=onlyTypeId?[onlyTypeId.toLowerCase()]:new Set([...baseTypes,...p.openingBalances.map(o=>o.typeId.toLowerCase()),...(value?.types??[])]),start=ordinal(p.accountingStart);
  for(const type of types){const end=value?.horizons.get(type);work+=Math.max(0,ordinal(end&&end>through?end:through)-start+1)*10+(value?.count??0)*10;if(work>stopAt)return work;}
 }
 return work;
}
export function assertLeaveQueryBudget(source:LeaveCalculationSource,through:string,membershipIds?:readonly string[],onlyTypeId?:string):void {if(leaveQueryWork(source,through,membershipIds,onlyTypeId,LEAVE_QUERY_WORK_LIMIT)>LEAVE_QUERY_WORK_LIMIT)throw new DomainError('LEAVE_CALCULATION_LIMIT','This leave calculation exceeds the supported query work budget. Narrow the people or date range.',{retryable:false});}
export function assertLeaveAvailabilityBudget(source:LeaveCalculationSource,start:string,end:string,membershipIds:readonly string[]):void {const days=Math.max(0,dateOrdinal(end)-dateOrdinal(start)+1),ids=new Set(membershipIds.map(id=>id.toLowerCase()));let work=source.requests.length;for(const p of source.profiles)if(ids.has(p.membershipId.toLowerCase()))work+=days*(1+p.schedulePeriods.length);if(work>LEAVE_QUERY_WORK_LIMIT)throw new DomainError('LEAVE_CALCULATION_LIMIT','This capacity calculation exceeds the supported query work budget. Narrow the people or date range.',{retryable:false});}

export function assertLeaveRangeBatchBudget(source:LeaveCalculationSource,ranges:readonly {membershipId:string;startDate:string;endDate:string}[]):void {const schedules=new Map(source.profiles.map(p=>[p.membershipId.toLowerCase(),1+p.schedulePeriods.length]));let work=source.requests.length;for(const r of ranges){work+=Math.max(0,dateOrdinal(r.endDate)-dateOrdinal(r.startDate)+1)*(schedules.get(r.membershipId.toLowerCase())??1);if(work>LEAVE_QUERY_WORK_LIMIT)throw new DomainError('LEAVE_CALCULATION_LIMIT','This absence batch exceeds the supported calculation budget. Select fewer people or a shorter interval.',{retryable:false});}}
