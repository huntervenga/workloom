import {QueryClientProvider} from '@tanstack/react-query';
import {screen,waitFor} from '@testing-library/react';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {PlanningCheckIssuesDialog} from './PlanningCheckIssuesDialog';
import {assessment,RULE,TASK} from './testFixtures';
import {alpha,anna,installFakeApi,ok,failure} from '../../test/fakeApi';
import {PROJECT_ID,renderFieldUi} from '../fields/test/fixtures';
afterEach(()=>vi.unstubAllGlobals());
describe('pinned complete issue pages',()=>{
 it('resets pagination to zero on a different rule/source and never silently retries a stale assessment',async()=>{
 const prefix=`/api/v1/workspaces/${alpha.id}/projects/${PROJECT_ID}/planning-checks/issues`,nextRule='70000000-0000-4000-8000-000000000002';const api=installFakeApi({[`GET ${prefix}`]:req=>{const offset=Number(req.searchParams.get('offset')),ruleId=req.searchParams.get('ruleId')??RULE,sourceVersion=req.searchParams.get('expectedSourceVersion')??'';if(sourceVersion==='b'.repeat(64))return failure(409,'CONFLICT','Synthetic stale source');return ok({sourceVersion,ruleId,total:51,offset,limit:50,rows:Array.from({length:offset===0?50:1},(_,index)=>({taskId:index===0?TASK:`72000000-0000-4000-8000-${String(index).padStart(12,'0')}`,title:`Issue ${offset+index}`,sectionId:null,primaryAssigneeId:null}))});}});
 const onClose=vi.fn(),onRefresh=vi.fn(),onOpenTask=vi.fn(),input={expectedSettingsRevision:2,expectedSourceVersion:assessment.sourceVersion,ruleId:RULE};const props={actorId:anna.id,workspaceId:alpha.id,projectId:PROJECT_ID,input,name:'Estimate reminder',onClose,onRefresh,onOpenTask};const ui=renderFieldUi(<PlanningCheckIssuesDialog {...props}/>);await screen.findByRole('button',{name:'Issue 0'});await ui.user.click(screen.getByRole('button',{name:'Next'}));await screen.findByRole('button',{name:'Issue 50'});ui.rerender(<QueryClientProvider client={ui.client}><PlanningCheckIssuesDialog {...props} input={{...input,ruleId:nextRule}}/></QueryClientProvider>);await screen.findByRole('button',{name:'Issue 0'});expect(api.calls.at(-1)?.searchParams.get('offset')).toBe('0');ui.rerender(<QueryClientProvider client={ui.client}><PlanningCheckIssuesDialog {...props} input={{...input,ruleId:nextRule,expectedSourceVersion:'b'.repeat(64)}}/></QueryClientProvider>);await screen.findByRole('alert');expect(screen.queryByRole('button',{name:'Issue 0'})).toBeNull();await ui.user.click(screen.getByRole('button',{name:'Close and refresh checks'}));expect(onClose).toHaveBeenCalledOnce();expect(onRefresh).toHaveBeenCalledOnce();await waitFor(()=>expect(api.calls.filter(call=>call.searchParams.get('expectedSourceVersion')==='b'.repeat(64))).toHaveLength(1));expect(onOpenTask).not.toHaveBeenCalled();
 });
});
