import {describe,expect,it,vi} from 'vitest';
import type {TaskDto} from '@workloom/contracts';
import type {DependencyRepository} from './ports.js';
import {createTaskStatusTransitionPolicy} from './status-policy.js';
const task={id:'task',workspaceId:'ws',projectId:'project',statusId:'old'} as TaskDto;
function fixture(mode:'warn'|'enforce',group:'todo'|'in_progress'|'done'|'cancelled',count=1){const counts=vi.fn(async()=>new Map([[task.id,count]]));const repo={tasks:{findStatus:async()=>({id:'next',projectId:task.projectId,group})},getPolicy:async()=>({mode}),unresolvedCounts:counts} as unknown as DependencyRepository;return {policy:createTaskStatusTransitionPolicy(repo,async()=>{}),counts};}
describe('shared in-scope task status dependency policy',()=>{
 it('permits same-status noop without looking at current blockers',async()=>{const {policy,counts}=fixture('enforce','done');await policy.assertTransition(task,task.statusId);expect(counts).not.toHaveBeenCalled();});
 it.each(['in_progress','done'] as const)('rejects unresolved enforce transition into %s',async group=>{await expect(fixture('enforce',group).policy.assertTransition(task,'next')).rejects.toMatchObject({code:'DOMAIN_VALIDATION_FAILED'});});
 it.each(['todo','cancelled'] as const)('permits leaving blocked status into %s',async group=>{await expect(fixture('enforce',group).policy.assertTransition(task,'next')).resolves.toBeUndefined();});
 it('permits warn or fully resolved enforce transitions',async()=>{await fixture('warn','done').policy.assertTransition(task,'next');await fixture('enforce','done',0).policy.assertTransition(task,'next');});
});

describe('shared status completion entry policy',()=>{
 function policy(oldGroup:'todo'|'done',nextGroup:'todo'|'in_progress'|'done',reject=false){const completion=vi.fn(async()=>{if(reject)throw Error('Required field missing');});const repo={tasks:{findStatus:async(_ws:string,id:string)=>({id,projectId:task.projectId,group:id===task.statusId?oldGroup:nextGroup})},getPolicy:async()=>({mode:'warn'}),unresolvedCounts:async()=>new Map()} as unknown as DependencyRepository;return{completion,policy:createTaskStatusTransitionPolicy(repo,completion)};}
 it('does not gate ordinary edits/same-status saves or movements among existing done statuses',async()=>{const f=policy('done','done',true);await f.policy.assertTransition(task,task.statusId);await f.policy.assertTransition(task,'another-done');expect(f.completion).not.toHaveBeenCalled();});
 it('gates done entry and forwards atomic prospective/candidate options unchanged',async()=>{const f=policy('todo','done'),options={fieldValues:[{fieldId:'field',value:{type:'duration' as const,value:0}}],prospective:{responsibleMembershipId:null}};await f.policy.assertTransition(task,'done',options);expect(f.completion).toHaveBeenCalledWith(task,options);});
 it('checks creation even when its initial status id equals the destination',async()=>{const f=policy('done','done',true);await expect(f.policy.assertTransition(task,task.statusId,{creating:true})).rejects.toThrow('Required field missing');});
 it('never prevents reopening or in-progress work because of completion requirements',async()=>{const f=policy('done','in_progress',true);await f.policy.assertTransition(task,'progress');expect(f.completion).not.toHaveBeenCalled();});
});
