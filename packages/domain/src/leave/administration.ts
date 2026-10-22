import type {LeaveCalculationSource,LeaveWarningDto,LeaveWarningsDto,LeaveAcceptedWarningsDto,LeaveWarningCode,LeaveRequestDto} from '@workloom/contracts';
import {dateYear,isEmployed,sameLeaveId,policyVersionForYearOptional,leaveTypeForDateOptional} from './calendar.js';
import {balanceTypeIds,calculateLeaveBalance,historicalLeaveDeficit} from './accrual.js';
import {assertLeaveQueryBudget} from './budget.js';
import type {LeaveBalanceDto} from '@workloom/contracts';
export interface AdministrationContext {canManage:boolean;today:string;membershipId?:string;memberToday?:Readonly<Record<string,string>>;balances?:readonly LeaveBalanceDto[]}

/** Scope before diagnostics and truncation; raw notes are never part of presentation metadata. */
export function evaluateLeaveDiagnostics({source:raw,context}:{source:LeaveCalculationSource;context:AdministrationContext}):{presentation:LeaveWarningsDto;accepted:LeaveAcceptedWarningsDto} {
 const source=context.canManage?raw:{...raw,profiles:raw.profiles.filter(p=>context.membershipId!==undefined&&sameLeaveId(p.membershipId,context.membershipId)),requests:raw.requests.filter(r=>context.membershipId!==undefined&&sameLeaveId(r.membershipId,context.membershipId)),adjustments:raw.adjustments.filter(a=>context.membershipId!==undefined&&sameLeaveId(a.membershipId,context.membershipId))};
 assertLeaveQueryBudget(source,context.today);
 const warnings:LeaveWarningDto[]=[],seen=new Set<string>(),codes=new Set<LeaveWarningCode>();let totalCount=0;
 function add(code:LeaveWarningCode,entity:LeaveWarningDto['entity'],entityId:string,membershipId:string,startDate:string|null,endDate:string|null,typeId:string|null=null,availableMicrodays:number|null=null){
  const key=JSON.stringify([code,entity,entityId,startDate,endDate,typeId]);if(seen.has(key))return;seen.add(key);codes.add(code);totalCount++;if(warnings.length<100)warnings.push({code,entity,entityId,membershipId,startDate,endDate,typeId,availableMicrodays});
 }
 const flags=(t:{consumesBalance:boolean;pausesAccrual:boolean;capacityUnavailable:boolean})=>JSON.stringify([t.consumesBalance,t.pausesAccrual,t.capacityUnavailable]);
 const signature=(t:{consumesBalance:boolean;pausesAccrual:boolean;capacityUnavailable:boolean;requiresApproval:boolean})=>JSON.stringify([t.consumesBalance,t.pausesAccrual,t.capacityUnavailable,t.requiresApproval]);
 for(const p of source.profiles){
  const asOf=context.memberToday?.[p.membershipId]??context.today;
  if(p.accountingStart<p.employmentStart)add('ACCOUNTING_BEFORE_EMPLOYMENT','profile',p.membershipId,p.membershipId,p.accountingStart,p.employmentStart);
  for(const o of p.openingBalances){if(o.microdays<0)add('NEGATIVE_OPENING','profile',p.membershipId,p.membershipId,p.accountingStart,null,o.typeId,o.microdays);if(!leaveTypeForDateOptional(source.settings,o.typeId,p.accountingStart))add('MISSING_TYPE','profile',p.membershipId,p.membershipId,p.accountingStart,null,o.typeId);}
  for(let year=dateYear(p.accountingStart);year<=dateYear(asOf);year++)if(!policyVersionForYearOptional(source.settings,year))add('MISSING_POLICY','profile',p.membershipId,p.membershipId,`${year}-01-01`,`${year}-12-31`);
  const memberSource={...source,profiles:[p],requests:source.requests.filter(r=>r.membershipId===p.membershipId),adjustments:source.adjustments.filter(a=>a.membershipId===p.membershipId)};
  for(const typeId of balanceTypeIds(memberSource,p.membershipId)){
   const balance=context.balances?.find(b=>b.membershipId===p.membershipId&&b.typeId===typeId&&b.asOf===asOf)??calculateLeaveBalance(memberSource,{membershipId:p.membershipId,typeId,asOf});
   // Preserve recovered historical debt as one bounded, dated diagnostic per pool.
   const historical=historicalLeaveDeficit(memberSource,{membershipId:p.membershipId,typeId,asOf});
   const current=Math.min(balance.availableMicrodays,balance.projectedAvailableMicrodays);
   const worst=historical&&historical.availableMicrodays<current?historical:{date:asOf,availableMicrodays:current};
   if(worst.availableMicrodays<0){add('NEGATIVE_BALANCE','profile',p.membershipId,p.membershipId,worst.date,worst.date<asOf?worst.date:balance.projectedThroughDate,typeId,worst.availableMicrodays);if(memberSource.requests.some(r=>r.status==='approved'&&r.pausesAccrual))add('PAID_POOL_DEBT','profile',p.membershipId,p.membershipId,worst.date,worst.date<asOf?worst.date:balance.projectedThroughDate,typeId,worst.availableMicrodays);}
  }
 }
 const active=source.requests.filter(r=>r.status==='approved'||r.status==='pending');
 for(const r of active){
  const p=source.profiles.find(p=>sameLeaveId(p.membershipId,r.membershipId));if(!p)continue;
  if(!isEmployed(p,r.startDate)||!isEmployed(p,r.endDate))add('OUTSIDE_EMPLOYMENT','request',r.id,r.membershipId,r.startDate,r.endDate,r.typeId);
  if(r.startDate<p.accountingStart)add('BEFORE_ACCOUNTING','request',r.id,r.membershipId,r.startDate,r.endDate,r.typeId);
  for(let year=dateYear(r.startDate);year<=dateYear(r.endDate);year++){
   const policy=policyVersionForYearOptional(source.settings,year),type=leaveTypeForDateOptional(source.settings,r.typeId,`${year}-12-31`),start=r.startDate>`${year}-01-01`?r.startDate:`${year}-01-01`,end=r.endDate<`${year}-12-31`?r.endDate:`${year}-12-31`;
   if(!policy)add('MISSING_POLICY','request',r.id,r.membershipId,start,end,r.typeId);
   else if(!type)add('MISSING_TYPE','request',r.id,r.membershipId,start,end,r.typeId);
   else{const startType=leaveTypeForDateOptional(source.settings,r.typeId,r.startDate);if(startType&&signature(startType)!==signature(type))add('TYPE_BEHAVIOR_CHANGED','request',r.id,r.membershipId,start,end,r.typeId);if(type.archived)add('ARCHIVED_TYPE','request',r.id,r.membershipId,start,end,r.typeId);if(flags(type)!==flags(r))add('TYPE_BEHAVIOR_CHANGED','request',r.id,r.membershipId,start,end,r.typeId);}
  }
 }
 // One bounded overlap diagnostic per conflicting record; balance/capacity keep their own union semantics.
 const farthest=new Map<string,LeaveRequestDto>();
 for(const r of [...active].sort((a,b)=>a.startDate.localeCompare(b.startDate)||a.id.localeCompare(b.id))){const last=farthest.get(r.membershipId);if(last&&last.endDate>=r.startDate){for(const item of [last,r])add('OVERLAP','request',item.id,item.membershipId,item.startDate,item.endDate,item.typeId);}if(!last||last.endDate<r.endDate)farthest.set(r.membershipId,r);}
 for(const a of source.adjustments){const p=source.profiles.find(p=>sameLeaveId(p.membershipId,a.membershipId));if(!p)continue;if(a.effectiveDate<p.accountingStart)add('ADJUSTMENT_BEFORE_ACCOUNTING','adjustment',a.id,a.membershipId,a.effectiveDate,p.accountingStart,a.typeId,a.deltaMicrodays);const policy=policyVersionForYearOptional(source.settings,dateYear(a.effectiveDate));if(!policy)add('MISSING_POLICY','adjustment',a.id,a.membershipId,a.effectiveDate,null,a.typeId);else if(!leaveTypeForDateOptional(source.settings,a.typeId,a.effectiveDate))add('MISSING_TYPE','adjustment',a.id,a.membershipId,a.effectiveDate,null,a.typeId);}
 return {presentation:{warnings,totalCount,truncated:totalCount>100},accepted:{codes:[...codes].sort(),count:totalCount}};
}
/** Pure presentation wrapper; audit uses the same request-local diagnostic result. */
export function evaluateLeaveWarnings(input:Parameters<typeof evaluateLeaveDiagnostics>[0]):LeaveWarningsDto{return evaluateLeaveDiagnostics(input).presentation;}
