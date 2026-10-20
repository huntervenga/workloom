import {describe,expect,it,vi} from 'vitest';
import {getTableName} from 'drizzle-orm';
import type {GenericReportConfig} from '@workloom/contracts';
import type {WorkloomExecutor} from '../client.js';
const loader=vi.hoisted(()=>vi.fn(async()=>{throw Error('synthetic full shared-source overflow');}));
vi.mock('../shared-activities/repository.js',()=>({loadSharedActivitySources:loader}));
import {createGenericReportRepository} from './repository.js';
const id=(n:number)=>`c0000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function tx():WorkloomExecutor {
 return {select:()=>{let table='';const query={from(value:Parameters<typeof getTableName>[0]){table=getTableName(value);return query;},where(){return query;},orderBy(){return query;},limit(){return query;},innerJoin(){return query;},leftJoin(){return query;},then(resolve:(value:unknown)=>unknown,reject:(error:unknown)=>unknown){return Promise.resolve(table==='workspaces'?[{seq:1,epoch:0}]:[]).then(resolve,reject);}};return query;}} as unknown as WorkloomExecutor;
}
const config:GenericReportConfig={projectId:id(2),hierarchy:'all_tasks',measures:[{key:'ordinary',operation:'sum',fieldId:id(3)}],comparison:null,groupBy:{kind:'none'},filters:{statusGroups:[],tagIds:[],assignee:{kind:'all'},dateRange:null}};
describe('ordinary report source independence',()=>{
 it('doesnotreadorboundsharedparticipation forordinarySUM/countsources',async()=>{loader.mockClear();const repo=createGenericReportRepository(tx(),id(1));expect((await repo.source(config)).sharedActivities).toBeUndefined();expect(loader).not.toHaveBeenCalled();await expect(repo.source({...config,measures:[{key:'effort',operation:'personal_effort',fieldId:id(3)}]})).rejects.toThrow('shared-source overflow');expect(loader).toHaveBeenCalledTimes(1);});
 it('loads sharedsources onlyforexplicitheader/checkrequest',async()=>{loader.mockClear();const repo=createGenericReportRepository(tx(),id(1));await expect(repo.source(config,[],{includeSharedActivities:true})).rejects.toThrow('shared-source overflow');expect(loader).toHaveBeenCalledTimes(1);});
});
