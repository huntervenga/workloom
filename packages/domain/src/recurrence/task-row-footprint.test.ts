import type { CreateTaskRowInput } from '@workloom/contracts';
import { describe, expect, it } from 'vitest';
import { createPlanningMutationGuard } from '../planning/freeze.js';
import type { PlanningMutationIntent, PlanningRepository, PlanningWriteScope } from '../planning/ports.js';
import { resolveRecurrenceAffectedProjects, type RecurrenceFootprintScope } from './footprint.js';
import type { RecurrenceGuardIntent } from './ports.js';

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const ws=id(1),project=id(2),other=id(3),samePeriod=id(4),otherPeriod=id(5),existingTask=id(6),missingPeriod=id(7);
const periodOwners=new Map([[samePeriod,project],[otherPeriod,other]]);

// Minimal typed reads for this footprint only; the cast stays inside this test helper.
function footprintScope(knownProjects:string[]):{scope:RecurrenceFootprintScope;reads:string[]} {
  const reads:string[]=[];
  const repository={
    tasks:{
      findProject:async(_ws:string,pid:string)=>{reads.push(`project:${pid}`);return knownProjects.includes(pid)?{id:pid}:null;},
      findTask:async(_ws:string,tid:string)=>{reads.push(`task:${tid}`);return tid===existingTask?{id:tid,projectId:project}:null;},
    },
    findPeriod:async(_ws:string,pid:string)=>{reads.push(`period:${pid}`);const owner=periodOwners.get(pid);return owner?{id:pid,projectId:owner}:null;},
  } as unknown as PlanningRepository;
  return {scope:{context:{workspaceId:ws},repository,recurrence:{} as RecurrenceFootprintScope['recurrence']},reads};
}
const row=(extra:Partial<Pick<CreateTaskRowInput,'plan'|'actual'>>={}):CreateTaskRowInput=>({task:{projectId:project,title:'Row',statusId:id(9)},...extra});
const plan=(periodId:string)=>({periodId,membershipId:id(10),expectedRevision:null,plannedMinutes:60});
const actual=(periodId:string)=>({periodId,membershipId:id(10),minutes:30});
const rowIntent=(input:CreateTaskRowInput,projectId=input.task.projectId):PlanningMutationIntent=>({family:'task_row',command:'task.row.create',target:{projectId},input});

describe('task row recurrence footprint',()=>{
  it('resolves the task project once when the explicit plan and actual periods belong to it',async()=>{
    const {scope,reads}=footprintScope([project]);
    expect(await resolveRecurrenceAffectedProjects(scope,rowIntent(row({plan:plan(samePeriod),actual:actual(samePeriod)})))).toEqual({kind:'projects',projectIds:[project]});
    // No lookup by a task, value or package ID: the fresh row has none allocated yet.
    expect(reads).toEqual([`project:${project}`,`period:${samePeriod}`,`period:${samePeriod}`]);
    expect(await resolveRecurrenceAffectedProjects(footprintScope([project]).scope,rowIntent(row()))).toEqual({kind:'projects',projectIds:[project]});
  });

  it('fails closed on a period of another project or a missing period',async()=>{
    const {scope}=footprintScope([project]);
    await expect(resolveRecurrenceAffectedProjects(scope,rowIntent(row({plan:plan(otherPeriod)})))).rejects.toMatchObject({code:'DOMAIN_VALIDATION_FAILED'});
    await expect(resolveRecurrenceAffectedProjects(scope,rowIntent(row({plan:plan(samePeriod),actual:actual(otherPeriod)})))).rejects.toMatchObject({code:'DOMAIN_VALIDATION_FAILED'});
    await expect(resolveRecurrenceAffectedProjects(scope,rowIntent(row({actual:actual(missingPeriod)})))).rejects.toMatchObject({code:'NOT_FOUND'});
  });

  it('yields none for a missing task project without reading periods',async()=>{
    const {scope,reads}=footprintScope([]);
    expect(await resolveRecurrenceAffectedProjects(scope,rowIntent(row({plan:plan(otherPeriod)})))).toEqual({kind:'none'});
    expect(reads).toEqual([`project:${project}`]);
  });

  it('treats a target and input project mismatch as a composition defect',async()=>{
    const {scope}=footprintScope([project,other]);
    await expect(resolveRecurrenceAffectedProjects(scope,rowIntent(row(),other))).rejects.toThrow('task row target and input project differ');
  });

  it('keeps task.move resolving its target task project',async()=>{
    const {scope}=footprintScope([project]);
    expect(await resolveRecurrenceAffectedProjects(scope,{family:'task',command:'task.move',target:existingTask,input:{}})).toEqual({kind:'projects',projectIds:[project]});
  });

  it('rejects in the shared guard before any due freeze, census or lock read',async()=>{
    const {scope}=footprintScope([project]);
    const calls:string[]=[];
    const repository={...scope.repository,listPeriods:async()=>{calls.push('periods');return [];},listLocks:async()=>{calls.push('locks');return [];}} as unknown as PlanningRepository;
    const resolverScope={...scope,repository};
    const recurrenceCensus={
      resolveAffectedProjects:(intent:RecurrenceGuardIntent)=>resolveRecurrenceAffectedProjects(resolverScope,intent),
      assessPeriod:async()=>{calls.push('assess');throw new Error('unreachable');},
      ensurePeriod:async()=>{calls.push('ensure');throw new Error('unreachable');},
      requireCompleteCensus:async()=>{calls.push('census');},
    } as unknown as PlanningWriteScope['recurrenceCensus'];
    const guard=createPlanningMutationGuard({context:{workspaceId:ws},repository,recurrenceCensus} as unknown as PlanningWriteScope,{newId:()=>id(99),digest:value=>value});
    await expect(guard.check(rowIntent(row({plan:plan(otherPeriod)})))).rejects.toMatchObject({code:'DOMAIN_VALIDATION_FAILED'});
    await expect(guard.check(rowIntent(row({actual:actual(missingPeriod)})))).rejects.toMatchObject({code:'NOT_FOUND'});
    expect(calls).toEqual([]);
  });
});
