import { originalPackageEstimateSchema, type PackageBaselineDto, type ProjectDto } from '@workloom/contracts';
import { describe, expect, it } from 'vitest';
import type { CommandContext } from '../access/context.js';
import { DomainError } from '../errors.js';
import type { WorkPackageRecord } from '../tasks/ports.js';
import { createPlanningApplication } from './service.js';
import type { OriginalPackageEstimateSource, PlanningRepository, PlanningTools, PlanningUnitOfWork } from './ports.js';

// Pure source-selection and access-ordering checks; the isolated PostgreSQL suite owns real freezes.
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const ws=id(1),other=id(2),project=id(3),pkg=id(4),planBaseline=id(5),period=id(6),packageBaseline=id(7),time='2026-10-16T09:00:00.000Z',later='2026-10-20T09:00:00.000Z';
const ctx:CommandContext={workspaceId:ws,actor:{userId:id(20),displayName:'Synthetic owner',kind:'fixture'},source:'web',requestId:'test'};
const tools:PlanningTools={newId:()=>id(99),digest:value=>value,encodeCursor:()=>'',decodeCursor:()=>{throw new Error('unused');}};
const workPackage=(estimateMinutes:number|null):WorkPackageRecord=>({id:pkg,workspaceId:ws,projectId:project,origin:'new_task',sourcePackageId:null,estimateMinutes,revision:3,createdAt:time,updatedAt:later});
const origin={planBaselineId:planBaseline,periodId:period,periodLocalStart:'2026-10-12',scope:'project' as const,mode:'manual' as const,frozenAt:time};
const observation=(estimateMinutes:number|null)=>({workspaceId:ws,projectId:project,workPackageId:pkg,estimateMinutes,packageRevision:1,baselineId:planBaseline});
const knownBaseline=(estimateMinutes:number):PackageBaselineDto=>({id:packageBaseline,workspaceId:ws,projectId:project,workPackageId:pkg,estimateMinutes,sourcePackageRevision:1,sourceBaselineId:planBaseline,acceptedAt:time,provenance:'first_known_plan_freeze'});

interface Setup {current?:WorkPackageRecord|null;projectFound?:boolean;source?:OriginalPackageEstimateSource|null;authorized?:boolean}
function application(setup:Setup={}) {
  const events:string[]=[];
  const repo={
    tasks:{
      findWorkPackage:async(workspaceId:string,packageId:string)=>{events.push(`package:${workspaceId}:${packageId}`);const row=setup.current===undefined?workPackage(1200):setup.current;return row&&row.workspaceId===workspaceId?row:null;},
      findProject:async(workspaceId:string,projectId:string)=>{events.push(`project:${workspaceId}:${projectId}`);return setup.projectFound===false?null:{id:projectId,workspaceId} as ProjectDto;},
    },
    findOriginalPackageEstimateSource:async(workspaceId:string,packageId:string)=>{events.push(`observation:${workspaceId}:${packageId}`);return setup.source??null;},
  } as unknown as PlanningRepository;
  const writer:PlanningUnitOfWork={
    run:async()=>{throw new Error('A read must never open a write unit.');},
    read:async(context,capability,work)=>{
      events.push(`authorize:${context.workspaceId}:${capability}`);
      if(setup.authorized===false)throw new DomainError('NOT_FOUND','The resource was not found.');
      return work(repo);
    },
  };
  return {planning:createPlanningApplication({reader:repo,writer,tools}),events};
}

describe('original package estimate read projection', () => {
  it('reports not_captured_yet for a fresh known current estimate and never exposes that current value', async () => {
    const {planning,events}=application({current:workPackage(1200),source:null});
    const result=await planning.getOriginalPackageEstimate(ctx,pkg.toUpperCase());
    expect(result).toEqual({state:'not_captured_yet',workspaceId:ws,projectId:project,workPackageId:pkg});
    expect(originalPackageEstimateSchema.parse(result)).toEqual(result);
    expect(JSON.stringify(result)).not.toContain('1200');
    expect(events).toEqual([`authorize:${ws}:task.read`,`package:${ws}:${pkg}`,`project:${ws}:${project}`,`observation:${ws}:${pkg}`]);
  });

  it('keeps an unknown first observation unknown after a later fill, even without estimate protection', async () => {
    // protectEstimate:false creates no lock, yet the first observation stays null and no package baseline exists.
    const {planning}=application({current:workPackage(480),source:{observation:observation(null),origin,packageBaseline:null}});
    const result=await planning.getOriginalPackageEstimate(ctx,pkg);
    expect(result).toEqual({state:'original_unknown',workspaceId:ws,projectId:project,workPackageId:pkg,estimateMinutes:null,packageBaselineId:null,origin:{...origin,packageRevision:1}});
    expect(JSON.stringify(result)).not.toContain('480');
    expect(JSON.stringify(result)).not.toContain(later);
  });

  it('returns a captured zero as a known original with immutable first-freeze provenance', async () => {
    const {planning}=application({current:workPackage(600),source:{observation:observation(0),origin,packageBaseline:knownBaseline(0)}});
    const result=await planning.getOriginalPackageEstimate(ctx,pkg);
    expect(result).toEqual({state:'captured',workspaceId:ws,projectId:project,workPackageId:pkg,estimateMinutes:0,packageBaselineId:packageBaseline,acceptedAt:time,provenance:'first_known_plan_freeze',origin:{...origin,packageRevision:1}});
    expect(originalPackageEstimateSchema.parse(result)).toEqual(result);
  });

  it('keeps the captured original after the current estimate changes', async () => {
    const {planning}=application({current:workPackage(900),source:{observation:observation(1200),origin,packageBaseline:knownBaseline(1200)}});
    expect(await planning.getOriginalPackageEstimate(ctx,pkg)).toMatchObject({state:'captured',estimateMinutes:1200});
  });

  it('checks current access, then the package and project, before any observation read', async () => {
    const denied=application({authorized:false,source:{observation:observation(60),origin,packageBaseline:knownBaseline(60)}});
    await expect(denied.planning.getOriginalPackageEstimate(ctx,pkg)).rejects.toMatchObject({code:'NOT_FOUND'});
    expect(denied.events).toEqual([`authorize:${ws}:task.read`]);
    const foreign=application({current:{...workPackage(60),workspaceId:other},source:{observation:observation(60),origin,packageBaseline:knownBaseline(60)}});
    await expect(foreign.planning.getOriginalPackageEstimate(ctx,pkg)).rejects.toMatchObject({code:'NOT_FOUND'});
    expect(foreign.events.some(e=>e.startsWith('observation:'))).toBe(false);
    const missingProject=application({projectFound:false,source:{observation:observation(60),origin,packageBaseline:knownBaseline(60)}});
    await expect(missingProject.planning.getOriginalPackageEstimate(ctx,pkg)).rejects.toMatchObject({code:'NOT_FOUND'});
    expect(missingProject.events.some(e=>e.startsWith('observation:'))).toBe(false);
    const malformed=application();
    await expect(malformed.planning.getOriginalPackageEstimate(ctx,'not-a-uuid')).rejects.toMatchObject({code:'VALIDATION_FAILED'});
    expect(malformed.events).toEqual([]);
  });

  it('refuses inconsistent immutable provenance instead of guessing a state', async () => {
    const cases:OriginalPackageEstimateSource[]=[
      {observation:observation(null),origin,packageBaseline:knownBaseline(60)},
      {observation:observation(60),origin,packageBaseline:null},
      {observation:observation(60),origin,packageBaseline:knownBaseline(30)},
      {observation:observation(60),origin,packageBaseline:{...knownBaseline(60),sourcePackageRevision:2}},
      {observation:observation(60),origin:{...origin,planBaselineId:id(50)},packageBaseline:knownBaseline(60)},
      {observation:{...observation(60),projectId:id(51)},origin,packageBaseline:knownBaseline(60)},
    ];
    for(const source of cases) {
      const {planning}=application({source});
      await expect(planning.getOriginalPackageEstimate(ctx,pkg)).rejects.toThrow('Stored original estimate provenance is inconsistent.');
    }
  });
});
