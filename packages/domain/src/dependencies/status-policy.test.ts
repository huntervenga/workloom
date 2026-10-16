import {describe,expect,it,vi} from 'vitest';
import type {TaskDto} from '@workloom/contracts';
import type {DependencyRepository} from './ports.js';
import {createTaskStatusTransitionPolicy} from './status-policy.js';
const task={id:'task',workspaceId:'ws',projectId:'project',statusId:'old'} as TaskDto;
function fixture(mode:'warn'|'enforce',group:'todo'|'in_progress'|'done'|'cancelled',count=1){const counts=vi.fn(async()=>new Map([[task.id,count]]));const repo={tasks:{findStatus:async()=>({id:'next',projectId:task.projectId,group})},getPolicy:async()=>({mode}),unresolvedCounts:counts} as unknown as DependencyRepository;return {policy:createTaskStatusTransitionPolicy(repo),counts};}
describe('shared in-scope task status dependency policy',()=>{
 it('permits same-status noop without looking at current blockers',async()=>{const {policy,counts}=fixture('enforce','done');await policy.assertTransition(task,task.statusId);expect(counts).not.toHaveBeenCalled();});
 it.each(['in_progress','done'] as const)('rejects unresolved enforce transition into %s',async group=>{await expect(fixture('enforce',group).policy.assertTransition(task,'next')).rejects.toMatchObject({code:'DOMAIN_VALIDATION_FAILED'});});
 it.each(['todo','cancelled'] as const)('permits leaving blocked status into %s',async group=>{await expect(fixture('enforce',group).policy.assertTransition(task,'next')).resolves.toBeUndefined();});
 it('permits warn or fully resolved enforce transitions',async()=>{await fixture('warn','done').policy.assertTransition(task,'next');await fixture('enforce','done',0).policy.assertTransition(task,'next');});
});
