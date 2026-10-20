import { QueryClient } from '@tanstack/react-query';
import { describe,expect,it } from 'vitest';
import { invalidateFieldDefinitions } from './queries';
import { queryKeys } from '../../lib/queryKeys';
describe('report option catalog refresh',()=>{
 it('invalidates both workspace discovery/results and project reports without touching another workspace',async()=>{
 const client=new QueryClient(),root=queryKeys.workspace('actor','workspace'),keys=[...['sources','result'].map(kind=>[...root,'workspace-reports',kind]),[...root,'generic-reports','report']],other=[...queryKeys.workspace('actor','other'),'workspace-reports','sources'];
 for(const key of [...keys,other])client.setQueryData(key,{revision:1});
 await invalidateFieldDefinitions(client,'actor','workspace','project');
 for(const key of keys)expect(client.getQueryState(key)?.isInvalidated).toBe(true);expect(client.getQueryState(other)?.isInvalidated).toBe(false);
 });
});
