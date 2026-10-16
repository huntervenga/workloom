import {Client,InMemoryTransport} from '@modelcontextprotocol/client';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {createLocalMcpServer,type McpBridge} from './server.js';
import {BridgeError} from './bridge.js';
import {taskSchema} from '@workloom/contracts';
const requestId='10000000-0000-4000-8000-000000000001';
const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanups.splice(0))await close();});
async function connect(bridge:McpBridge){const server=createLocalMcpServer(bridge);const client=new Client({name:'workloom-unit',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);cleanups.push(async()=>{await client.close();await server.close();});return client;}
describe('actual SDK guarded tool handlers',()=>{
 it('constructs without auth/network side effects and lists only current authorized tools',async()=>{const bridge={listTools:vi.fn().mockResolvedValue({data:{tools:['list_projects']},meta:{requestId}}),callTool:vi.fn()};const s=createLocalMcpServer(bridge);expect(bridge.listTools).not.toHaveBeenCalled();await s.close();const client=await connect(bridge);const list=await client.listTools(undefined,{cacheMode:'refresh'});expect(list.tools.map(t=>t.name)).toEqual(['list_projects']);expect(list.tools.every(t=>t.annotations?.readOnlyHint)).toBe(true);});
 it('checks current credential on every list and denies a revoked long-lived session',async()=>{const bridge={listTools:vi.fn().mockResolvedValueOnce({data:{tools:['list_projects']},meta:{requestId}}).mockRejectedValueOnce(new Error('raw bearer secret')),callTool:vi.fn()};const c=await connect(bridge);expect((await c.listTools(undefined,{cacheMode:'refresh'})).tools).toHaveLength(1);await expect(c.listTools(undefined,{cacheMode:'refresh'})).rejects.toThrow('could not be authorized');expect(bridge.listTools).toHaveBeenCalledTimes(2);});
 it('independently checks saved-catalog calls and sanitizes controlled denials',async()=>{const bridge={listTools:vi.fn().mockResolvedValue({data:{tools:['list_projects']},meta:{requestId}}),callTool:vi.fn().mockRejectedValue(new BridgeError('UNAUTHENTICATED',401))};const c=await connect(bridge);await c.listTools();const result=await c.callTool({name:'list_projects',arguments:{}});expect(result.isError).toBe(true);expect(result.content).toEqual([{type:'text',text:JSON.stringify({error:{code:'UNAUTHENTICATED',message:'The Workloom tool request could not be completed.'}})}]);expect(bridge.callTool).toHaveBeenCalledWith('list_projects',{});});
 it('uses exact shared normalized input and typed result',async()=>{const bridge={listTools:vi.fn().mockResolvedValue({data:{tools:['search_tasks']},meta:{requestId}}),callTool:vi.fn().mockResolvedValue({data:{tool:'search_tasks',data:[],nextCursor:'next-synthetic'},meta:{requestId}})};const c=await connect(bridge);const result=await c.callTool({name:'search_tasks',arguments:{query:{projectId:requestId,limit:2}}});expect(result.isError).not.toBe(true);expect(result.structuredContent).toEqual({tool:'search_tasks',data:[],nextCursor:'next-synthetic'});expect(bridge.callTool).toHaveBeenCalledWith('search_tasks',{query:{projectId:requestId,limit:2}});});
 it('uses the additive scalar tag filter in the shared search contract', async () => {
  const tagId = 'abcdef00-0000-4000-8000-000000000801';
  const callTool = vi.fn().mockResolvedValue({data:{tool:'search_tasks',data:[],nextCursor:null},meta:{requestId}});
  const c = await connect({listTools:vi.fn(),callTool});
  const result = await c.callTool({name:'search_tasks',arguments:{query:{projectId:requestId,tagId:tagId.toUpperCase(),limit:2}}});
  expect(result.isError).not.toBe(true);
  expect(callTool).toHaveBeenCalledWith('search_tasks',{query:{projectId:requestId,tagId,limit:2}});
  callTool.mockClear();
  for (const query of [{projectId:requestId,tagId:[tagId]},{projectId:requestId,tagIds:[tagId]},{projectId:requestId,sort:'title'}]) {
   expect((await c.callTool({name:'search_tasks',arguments:{query}})).isError).toBe(true);
  }
  expect(callTool).not.toHaveBeenCalled();
 });
 it('advertises and forwards bounded due sorting through the shared search query', async () => {
  const callTool = vi.fn().mockResolvedValue({data:{tool:'search_tasks',data:[],nextCursor:'due-next'},meta:{requestId}});
  const c = await connect({listTools:async()=>({data:{tools:['search_tasks']},meta:{requestId}}),callTool});
  const catalog = await c.listTools();
  expect(JSON.stringify(catalog.tools[0]?.inputSchema)).toContain('due_asc');
  const query = {projectId:requestId,sort:'due_asc',limit:2,cursor:'due-cursor'};
  expect((await c.callTool({name:'search_tasks',arguments:{query}})).structuredContent).toEqual({tool:'search_tasks',data:[],nextCursor:'due-next'});
  expect(callTool).toHaveBeenCalledWith('search_tasks',{query});
  callTool.mockClear();
  for (const sort of ['due_desc',['due_asc'],{dueDate:'asc'}]) expect((await c.callTool({name:'search_tasks',arguments:{query:{projectId:requestId,sort}}})).isError).toBe(true);
  expect(callTool).not.toHaveBeenCalled();
 });
 it('never dispatches actor injection or malformed write inputs',async()=>{const bridge={listTools:vi.fn().mockResolvedValue({data:{tools:[]},meta:{requestId}}),callTool:vi.fn()};const c=await connect(bridge);expect((await c.callTool({name:'list_projects',arguments:{actorId:requestId}})).isError).toBe(true);expect((await c.callTool({name:'create_task',arguments:{}})).isError).toBe(true);expect(bridge.callTool).not.toHaveBeenCalled();});
});

const task=taskSchema.parse({id:requestId,workspaceId:requestId,projectId:requestId,sectionId:null,parentTaskId:null,workPackageId:requestId,workPackageRevision:1,title:'Synthetic task',description:'',statusId:requestId,responsibleMembershipId:null,participants:[],participantsRevision:1,dueDate:null,priority:'none',tags:[],estimateMinutes:null,revision:1,position:0,visibility:'workspace',archivedAt:null,createdAt:'2026-10-16T06:20:00Z',updatedAt:'2026-10-16T06:20:00Z'});
const createArgs={operationKey:'original-operation-key',input:{projectId:requestId,title:'Synthetic task',statusId:requestId}};
const updateArgs={operationKey:'original-update-key',taskId:requestId,input:{expectedRevision:1,title:'Changed',estimateMinutes:60,expectedWorkPackageRevision:1,participantMembershipIds:[requestId],expectedParticipantsRevision:1}};
const resultFor=(tool:'create_task'|'update_task')=>({data:{tool,data:task,nextCursor:null},meta:{requestId}});
describe('actual SDK keyed task mutations',()=>{
 it('advertises current writes with precise keyed annotations',async()=>{const c=await connect({listTools:async()=>({data:{tools:['create_task','update_task']},meta:{requestId}}),callTool:vi.fn()});const list=await c.listTools();expect(list.tools.map(t=>t.name)).toEqual(['create_task','update_task']);expect(list.tools[0]?.annotations).toMatchObject({readOnlyHint:false,destructiveHint:false,idempotentHint:true});expect(list.tools[1]?.annotations).toMatchObject({readOnlyHint:false,destructiveHint:true,idempotentHint:true});});
 it.each([['create_task',createArgs],['update_task',updateArgs]] as const)('forwards %s exact original key and independent guards',async(tool,args)=>{const callTool=vi.fn().mockResolvedValue(resultFor(tool));const c=await connect({listTools:vi.fn(),callTool});const result=await c.callTool({name:tool,arguments:args});expect(result.isError).not.toBe(true);expect(result.structuredContent).toEqual(resultFor(tool).data);expect(result._meta?.['workloom/requestId']).toBe(requestId);expect(callTool).toHaveBeenCalledWith(tool,args);});
 it.each([new BridgeError('TRANSPORT_ERROR'),new BridgeError('REQUEST_CANCELLED'),new BridgeError('INVALID_RESPONSE'),new BridgeError('TEMPORARILY_UNAVAILABLE',503)])('marks post-dispatch failure unknown without retry or new-key advice',async error=>{const callTool=vi.fn().mockRejectedValue(error);const c=await connect({listTools:vi.fn(),callTool});const result=await c.callTool({name:'create_task',arguments:createArgs});expect(result.isError).toBe(true);const text=result.content.find(v=>v.type==='text');expect(text?.type).toBe('text');if(text?.type==='text'){const data=JSON.parse(text.text);expect(data.error).toMatchObject({outcome:'unknown',operationKey:createArgs.operationKey});expect(data.error.message).toContain('EXACT original');expect(data.error.message).toContain('do not generate a new key');}expect(callTool).toHaveBeenCalledOnce();});
 it('explicit retry repeats exactly the original write and returns the typed receipt',async()=>{const callTool=vi.fn().mockRejectedValueOnce(new BridgeError('TRANSPORT_ERROR')).mockResolvedValueOnce(resultFor('create_task'));const c=await connect({listTools:vi.fn(),callTool});expect((await c.callTool({name:'create_task',arguments:createArgs})).isError).toBe(true);expect(callTool).toHaveBeenCalledOnce();expect((await c.callTool({name:'create_task',arguments:createArgs})).structuredContent).toEqual(resultFor('create_task').data);expect(callTool.mock.calls[0]).toEqual(callTool.mock.calls[1]);});
 it.each([401,403,409,422])('keeps confirmed HTTP%s rejection distinct from unknown writes',async status=>{const c=await connect({listTools:vi.fn(),callTool:vi.fn().mockRejectedValue(new BridgeError('CAPABILITY_REQUIRED',status))});const result=await c.callTool({name:'update_task',arguments:updateArgs});const text=result.content.find(v=>v.type==='text');if(text?.type!=='text')throw new Error('Expected controlled tool error');expect(JSON.parse(text.text).error).toMatchObject({outcome:'rejected',operationKey:updateArgs.operationKey});expect(text.text).not.toContain('Outcome unknown');});
});
