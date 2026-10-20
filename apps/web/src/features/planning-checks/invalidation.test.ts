import {describe,it,expect} from 'vitest';
import {QueryClient} from '@tanstack/react-query';
import {queryKeys} from '../../lib/queryKeys';
import {invalidateSections,invalidateStatuses} from '../projects/queries';
import {storeConfirmedTasks} from '../tasks/queries';
import {planningCheckKeys} from './queries';
describe('planning check source invalidation',()=>{
 for(const change of ['bulk','section','status']as const)it(`invalidates trusted project checks after ${change} ACK, without touching other actors`,async()=>{const client=new QueryClient();const key=[...planningCheckKeys.root('actor','workspace','project'),'assessment'];const other=[...planningCheckKeys.root('another','workspace','project'),'assessment'];client.setQueryData(key,{trusted:true});client.setQueryData(other,{trusted:true});client.setQueryData(queryKeys.sections('actor','workspace','project'),[]);client.setQueryData(queryKeys.statuses('actor','workspace','project'),[]);if(change==='bulk')await storeConfirmedTasks(client,'actor','workspace',[]);else if(change==='section')await invalidateSections(client,'actor','workspace','project');else await invalidateStatuses(client,'actor','workspace','project');expect(client.getQueryState(key)?.isInvalidated).toBe(true);expect(client.getQueryState(other)?.isInvalidated).toBe(false);client.clear();});
});
