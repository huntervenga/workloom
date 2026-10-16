import {describe,expect,it} from 'vitest';
import {categorizedWorkLogSchema,recategorizeWorkLogInputSchema,taskTimeSummaryInputSchema,taskTimeSummaryQuerySchema} from './categories.js';
import {manualPeriodWorkLogSchema,setManualPeriodWorkInputSchema} from './planning.js';
const id=(n:number)=>`abcdef00-0000-4000-8000-${String(n).padStart(12,'0')}`;
const oldLog={id:id(1),workspaceId:id(2),projectId:id(3),taskId:id(4),workPackageId:id(5),membershipId:id(6),periodId:id(7),sourceKind:'manual_period',sourceKey:`${id(4)}:${id(6)}:${id(7)}`,precision:'period',revision:1,revisionId:id(8),minutes:90,state:'active',reason:null,actorUserId:id(9),recordedAt:'2026-10-16T00:00:00.000Z',changeSeq:'1'};
describe('P2b compatibility and wire/domain boundary',()=>{
 it('leaves an old stored work response unchanged without adding a default category',()=>{
  expect(manualPeriodWorkLogSchema.parse(oldLog)).toEqual(oldLog);
  expect(Object.hasOwn(manualPeriodWorkLogSchema.parse(oldLog),'category')).toBe(false);
  expect(categorizedWorkLogSchema.safeParse(oldLog).success).toBe(false);
 });
 it('preserves old work.set parsed defaults and rejects category assignment through the hours input',()=>{
  expect(setManualPeriodWorkInputSchema.parse({expectedRevision:null,minutes:90})).toEqual({expectedRevision:null,minutes:90,state:'active',reason:null});
  expect(setManualPeriodWorkInputSchema.safeParse({expectedRevision:null,minutes:90,category:{kind:'uncategorized'}}).success).toBe(false);
 });
 it('parses strict wire CSV once and independently validates normalized arrays in domain',()=>{
  const wire=taskTimeSummaryQuerySchema.parse({taskIds:`${id(2).toUpperCase()},${id(1)}`});
  expect(wire.taskIds).toEqual([id(1),id(2)]);
  expect(taskTimeSummaryInputSchema.parse(wire)).toEqual(wire);
  expect(taskTimeSummaryQuerySchema.safeParse(wire).success).toBe(false);
  expect(taskTimeSummaryInputSchema.safeParse({taskIds:[id(1),id(1).toUpperCase()]}).success).toBe(false);
  expect(taskTimeSummaryQuerySchema.safeParse({taskIds:id(1),actorId:id(2)}).success).toBe(false);
 });
 it('keeps explicit recategorization separate from changing source identity, state or hours',()=>{
  const base={expectedWorkLogRevision:1,expectedBindingRevision:2,optionId:null,reason:'Correct category'};
  expect(recategorizeWorkLogInputSchema.safeParse(base).success).toBe(true);
  for(const forbidden of ['minutes','taskId','membershipId','periodId','state','actor'])expect(recategorizeWorkLogInputSchema.safeParse({...base,[forbidden]:1}).success).toBe(false);
 });
});
