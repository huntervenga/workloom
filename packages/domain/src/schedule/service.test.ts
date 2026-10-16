import {describe,it,expect,vi} from 'vitest';
import type {TaskDto} from '@workloom/contracts';
import {createTaskScheduleApplication} from './service.js';
import {canonicalJson} from '../tasks/service.js';
import type {TaskScheduleUnitOfWork,TaskScheduleApplicationDependencies} from './ports.js';
import type {CommandContext} from '../access/context.js';
const id='00000000-0000-4000-8000-000000000001',project='00000000-0000-4000-8000-000000000002',ws='00000000-0000-4000-8000-000000000003',user='00000000-0000-4000-8000-000000000004';
const at='2026-10-16T00:00:00.000Z';
const task:TaskDto={id,workspaceId:ws,projectId:project,sectionId:null,parentTaskId:null,workPackageId:id,workPackageRevision:1,title:'Schedule',description:'',statusId:id,responsibleMembershipId:null,participants:[],participantsRevision:1,startDate:'2026-10-16',dueDate:'2026-10-17',priority:'none',tags:[],estimateMinutes:null,revision:2,position:0,visibility:'workspace',archivedAt:null,createdAt:at,updatedAt:at,meetingId:null};
const context={workspaceId:ws,actor:{userId:user,kind:'fixture',displayName:'Test'},source:'web',requestId:'test',idempotencyKey:'old-key'} as CommandContext;
const input={rows:[{taskId:id,expectedRevision:1,startDate:'2026-10-16',dueDate:'2026-10-17'}],previewHash:'a'.repeat(64)};
function fixture(missing=false){
 const result={projectId:project,tasks:[task],asOfChangeSeq:'2'};
 const incidentEdges=vi.fn(async()=>Array.from({length:1001},()=>({}))),findIdempotency=vi.fn(async()=>({payloadHash:canonicalJson({command:'task.schedule.apply',target:{projectId:project},input}),result}));
 const tasks={findProject:async()=>({id:project}),findTasksByIds:async()=>missing?[]:[task],findIdempotency};
 const scope={context,dependencies:{tasks,incidentEdges},repository:{tasks}};
 const writer={run:async(_ctx:unknown,_cap:unknown,work:(s:unknown)=>unknown)=>work(scope),read:async(_ctx:unknown,_cap:unknown,work:(s:unknown)=>unknown)=>work(scope)} as TaskScheduleUnitOfWork;
 const app=createTaskScheduleApplication({writer,tools:{digest:v=>v,newId:()=>id}} as TaskScheduleApplicationDependencies);
 return {app,result,incidentEdges,findIdempotency};
}
describe('schedule receipt current access boundary',()=>{
 it('replays the exact successful outcome despite a later incident-edge overflow',async()=>{const f=fixture();expect(await f.app.applySchedule(context,project,input)).toEqual(f.result);expect(f.incidentEdges).not.toHaveBeenCalled();await expect(f.app.getScheduleContext(context,project,{taskIds:[id]})).rejects.toThrow('Too many dependency');expect(f.incidentEdges).toHaveBeenCalledOnce();});
 it('still checks current target visibility before receipt replay',async()=>{const f=fixture(true);await expect(f.app.applySchedule(context,project,input)).rejects.toThrow();expect(f.findIdempotency).not.toHaveBeenCalled();});
});
