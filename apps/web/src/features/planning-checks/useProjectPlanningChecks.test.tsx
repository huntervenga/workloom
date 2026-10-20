import {MemoryRouter} from 'react-router';
import {QueryClientProvider} from '@tanstack/react-query';
import type {PlanningCheckAssessmentDto, PlanningCheckSettingsDto} from '@workloom/contracts';
import {act,screen,waitFor} from '@testing-library/react';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {useProjectPlanningChecks} from './useProjectPlanningChecks';
import {assessment,settings,TASK} from './testFixtures';
import {alpha,anna,project,installFakeApi,ok,deferred,failure} from '../../test/fakeApi';
import {field,PROJECT_ID,renderFieldUi} from '../fields/test/fixtures';
import {task} from '../planning/test/fixtures';
import {createQueryClient} from '../../lib/queryClient';
import {queryKeys} from '../../lib/queryKeys';
import {reportKeys} from '../generic-reports/queries';
import {planningCheckKeys} from './queries';
afterEach(()=>vi.unstubAllGlobals());
function setup(){const client=createQueryClient({retry:false}),prefix=`/api/v1/workspaces/${alpha.id}/projects/${PROJECT_ID}/planning-checks`;client.setQueryData(queryKeys.me,{actor:anna});client.setQueryData(queryKeys.workspace(anna.id,alpha.id),alpha);client.setQueryData(queryKeys.project(anna.id,alpha.id,PROJECT_ID),project(alpha.id,PROJECT_ID,'Test'));const pending=deferred<Response>();let read=0,writes=0;const api=installFakeApi({[`GET ${prefix}/settings`]:()=>ok(settings),[`POST ${prefix}/query`]:()=>++read===1?ok(assessment):pending.promise,[`PUT ${prefix}/settings`]:()=>++writes===1?failure(503,'UNAVAILABLE','Synthetic uncertain response'):ok({...settings,revision:3})});function Harness(){const checks=useProjectPlanningChecks({actorId:anna.id,workspaceId:alpha.id,projectId:PROJECT_ID,projectRevision:1,fields:[field('Allowance','duration')],members:[],sections:[],tags:[],enabled:true,writable:true,requestedOpen:false,onOpenTask:()=>undefined});const advisory=checks.fieldAdvisory({...task,id:TASK,projectId:PROJECT_ID},field('Allowance','duration'));const linked=checks.fieldAdvisory({...task,id:TASK,projectId:'another'},field('Allowance','duration'));return<MemoryRouter>{checks.control}{checks.dialogs}<span data-testid="advisory">{advisory?.label??'neutral'}</span><span data-testid="linked">{linked?.label??'neutral'}</span></MemoryRouter>;}const ui=renderFieldUi(<Harness/>,client);return{...ui,pending,api};}
describe('current project planning assessment',()=>{
 it('keeps the confirmed same-scope flag during source refresh until a new result removes it, and leaves linked rows neutral',async()=>{const ui=setup();await screen.findByText('Missing Allowance');expect(screen.getByTestId('linked')).toHaveTextContent('neutral');act(()=>{void ui.client.invalidateQueries({queryKey:reportKeys.root(anna.id,alpha.id)});});await waitFor(()=>expect(ui.api.calls.filter(call=>call.method==='POST')).toHaveLength(2));expect(screen.getByTestId('advisory')).toHaveTextContent('Missing Allowance');ui.pending.resolve(ok({...assessment,taskFlags:[]}));await waitFor(()=>expect(screen.getByTestId('advisory')).toHaveTextContent('neutral'));});
 for(const access of ['member','revoked']as const)it(`preserves an open owner draft while ${access} authority disables every write, then restores editing only with current owner access`,async()=>{const ui=setup();await screen.findByText('Missing Allowance');await ui.user.click(screen.getByRole('button',{name:'Checks'}));await ui.user.click(screen.getByRole('button',{name:'Edit'}));const input=screen.getByLabelText('Check name');await ui.user.clear(input);await ui.user.type(input,'Retained unsent name');const revoke=()=>{if(access==='member')ui.client.setQueryData(queryKeys.workspace(anna.id,alpha.id),{...alpha,role:'member'});else void ui.client.invalidateQueries({queryKey:queryKeys.workspace(anna.id,alpha.id),exact:true});};act(revoke);await waitFor(()=>expect(input).toBeDisabled());expect(input).toHaveValue('Retained unsent name');expect(screen.getByRole('checkbox',{name:'Enable planning checks'})).toBeDisabled();expect(screen.getByRole('button',{name:'Apply rule'})).toBeDisabled();expect(screen.getByRole('button',{name:'Save checks'})).toBeDisabled();expect(screen.getByText('Close',{selector:'button',exact:true})).toBeEnabled();act(()=>ui.client.setQueryData(queryKeys.workspace(anna.id,alpha.id),alpha));await waitFor(()=>expect(input).toBeEnabled());expect(input).toHaveValue('Retained unsent name');await ui.user.click(screen.getByRole('button',{name:'Apply rule'}));act(revoke);expect(screen.getByRole('button',{name:'Save checks'})).toBeDisabled();await ui.user.click(screen.getByText('Close',{selector:'button',exact:true}));await ui.user.click(screen.getByRole('button',{name:'Discard changes'}));expect(screen.queryByRole('dialog',{name:'Planning checks'})).toBeNull();expect(ui.api.calls.filter(call=>call.method==='PUT')).toEqual([]);});
 it('retains the exact uncertain command while a member cannot retry, then reuses its body and key when owner access returns',async()=>{const ui=setup();await screen.findByText('Missing Allowance');await ui.user.click(screen.getByRole('button',{name:'Checks'}));await ui.user.click(screen.getByRole('button',{name:'Save checks'}));const retry=await screen.findByRole('button',{name:'Retry the same save'});const original=ui.api.calls.find(call=>call.method==='PUT');expect(original).toBeDefined();act(()=>ui.client.setQueryData(queryKeys.workspace(anna.id,alpha.id),{...alpha,role:'member'}));await waitFor(()=>expect(retry).toBeDisabled());await ui.user.click(retry);expect(ui.api.calls.filter(call=>call.method==='PUT')).toHaveLength(1);expect(screen.getByRole('dialog',{name:'Planning checks'})).toBeVisible();act(()=>ui.client.setQueryData(queryKeys.workspace(anna.id,alpha.id),alpha));await waitFor(()=>expect(retry).toBeEnabled());await ui.user.click(retry);await waitFor(()=>expect(screen.queryByRole('dialog',{name:'Planning checks'})).toBeNull());const repeated=ui.api.calls.filter(call=>call.method==='PUT');expect(repeated).toHaveLength(2);expect(repeated[1]?.body).toEqual(original?.body);expect(repeated[1]?.headers.get('Idempotency-Key')).toBe(original?.headers.get('Idempotency-Key'));});
 it('does not retain red warnings after a failed refresh or an authorization cache invalidation',async()=>{const ui=setup();await screen.findByText('Missing Allowance');act(()=>{void ui.client.invalidateQueries({queryKey:reportKeys.root(anna.id,alpha.id)});});ui.pending.resolve(failure(503,'UNAVAILABLE','Synthetic failure'));await screen.findByRole('alert');expect(screen.getByTestId('advisory')).toHaveTextContent('neutral');act(()=>{void ui.client.invalidateQueries({queryKey:queryKeys.workspace(anna.id,alpha.id),exact:true});});expect(screen.getByTestId('advisory')).toHaveTextContent('neutral');});
});

const SECOND_TASK='71000000-0000-4000-8000-000000000002';
const OTHER_PROJECT='e0000000-0000-4000-8000-000000000002';
function refreshExample() {
 const client=createQueryClient({retry:false}),prefix=`/api/v1/workspaces/${alpha.id}/projects/${PROJECT_ID}/planning-checks`;
 client.setQueryData(queryKeys.me,{actor:anna});
 client.setQueryData(queryKeys.workspace(anna.id,alpha.id),alpha);
 client.setQueryData(queryKeys.project(anna.id,alpha.id,PROJECT_ID),project(alpha.id,PROJECT_ID,'Test'));
 client.setQueryData(queryKeys.project(anna.id,alpha.id,OTHER_PROJECT),project(alpha.id,OTHER_PROJECT,'Other'));
 const firstFlag=assessment.taskFlags[0];if(!firstFlag)throw new Error('Expected the trusted fixture flag.');
 const confirmed:PlanningCheckAssessmentDto={...assessment,summary:{...assessment.summary,eligibleTasks:2,missingRequiredTasks:2},scope:{...assessment.scope,taskCount:2},rules:assessment.rules.map(rule=>({...rule,eligibleTasks:2,issueCount:2})),taskFlags:[firstFlag,{...firstFlag,taskId:SECOND_TASK}]};
 const settingsRefresh=deferred<Response>(),assessmentRefresh=deferred<Response>(),otherAssessment=deferred<Response>();
 let settingsReads=0,assessmentReads=0;
 const api=installFakeApi({
  [`GET ${prefix}/settings`]:()=>++settingsReads===1?ok(settings):settingsRefresh.promise,
  [`POST ${prefix}/query`]:()=>++assessmentReads===1?ok(confirmed):assessmentRefresh.promise.then(response=>response.clone()),
  [`GET /api/v1/workspaces/${alpha.id}/projects/${OTHER_PROJECT}/planning-checks/settings`]:()=>ok({...settings,projectId:OTHER_PROJECT}),
  [`POST /api/v1/workspaces/${alpha.id}/projects/${OTHER_PROJECT}/planning-checks/query`]:()=>otherAssessment.promise.then(response=>response.clone()),
 });
 function Harness({projectId=PROJECT_ID,enabled=true}:{projectId?:string;enabled?:boolean}) {
  const definition=field('Allowance','duration'),checks=useProjectPlanningChecks({actorId:anna.id,workspaceId:alpha.id,projectId,projectRevision:1,fields:[definition],members:[],sections:[],tags:[],enabled,writable:true,requestedOpen:false,onOpenTask:()=>undefined});
  return <MemoryRouter>{checks.control}<div data-testid="group">{checks.renderGroup({kind:'no_section',key:'no_section',section:null,sectionId:null,roots:[],taskCount:2})}</div>{[TASK,SECOND_TASK].map(id=>{const advisory=checks.fieldAdvisory({...task,id,projectId},definition);return <span key={id} data-testid={id} style={advisory?{color:advisory.color}:undefined}>{advisory?.label??'neutral'}</span>;})}</MemoryRouter>;
 }
 const ui=renderFieldUi(<Harness/>,client);
 return {...ui,api,confirmed,settingsRefresh,assessmentRefresh,otherAssessment,
  rerenderScope:(projectId:string,enabled=true)=>ui.rerender(<QueryClientProvider client={client}><Harness projectId={projectId} enabled={enabled}/></QueryClientProvider>),
  assessmentCalls:()=>api.calls.filter(call=>call.method==='POST'&&call.path===`${prefix}/query`).length,
 };
}

const expectWarnings=(count:number)=>{
 expect(screen.getByTestId('group')).toHaveTextContent(`Estimate reminder · ${count}`);
 expect(screen.getByTestId(SECOND_TASK)).toHaveTextContent('Missing Allowance');
 expect(screen.getByTestId(SECOND_TASK)).toHaveStyle({color:'#dc2626'});
};

describe('planning assessment background display',()=>{
 it('keeps both cell colors and section counts through settings and assessment refresh, then changes only the returned flag',async()=>{
  const ui=refreshExample();await waitFor(()=>expectWarnings(2));
  act(()=>{void ui.client.invalidateQueries({queryKey:reportKeys.root(anna.id,alpha.id)});});
  await waitFor(()=>expect(ui.client.getQueryState(planningCheckKeys.settings(anna.id,alpha.id,PROJECT_ID))?.fetchStatus).toBe('fetching'));
  expectWarnings(2);expect(screen.getByTestId(TASK)).toHaveStyle({color:'#dc2626'});
  ui.settingsRefresh.resolve(ok(settings));await waitFor(()=>expect(ui.assessmentCalls()).toBeGreaterThanOrEqual(2));
  expectWarnings(2);expect(screen.getByTestId(TASK)).toHaveTextContent('Missing Allowance');
  ui.assessmentRefresh.resolve(ok({...ui.confirmed,sourceVersion:'b'.repeat(64),taskFlags:ui.confirmed.taskFlags.filter(flag=>flag.taskId!==TASK),summary:{...ui.confirmed.summary,missingRequiredTasks:1},rules:ui.confirmed.rules.map(rule=>({...rule,issueCount:1}))}));
  await waitFor(()=>expect(screen.getByTestId(TASK)).toHaveTextContent('neutral'));expectWarnings(1);
  expect(ui.api.calls.filter(call=>call.method==='PUT')).toEqual([]);
 });
 it('keeps the same warning counts and colors when a successful refresh returns unchanged results',async()=>{
  const ui=refreshExample();await waitFor(()=>expectWarnings(2));
  act(()=>{void ui.client.invalidateQueries({queryKey:reportKeys.root(anna.id,alpha.id)});});
  await waitFor(()=>expect(ui.client.getQueryState(planningCheckKeys.settings(anna.id,alpha.id,PROJECT_ID))?.fetchStatus).toBe('fetching'));
  expectWarnings(2);ui.settingsRefresh.resolve(ok(settings));await waitFor(()=>expect(ui.assessmentCalls()).toBeGreaterThanOrEqual(2));expectWarnings(2);
  ui.assessmentRefresh.resolve(ok(ui.confirmed));
  await waitFor(()=>expect(ui.client.getQueryState([...planningCheckKeys.root(anna.id,alpha.id,PROJECT_ID),'assessment',{expectedSettingsRevision:settings.revision},1])?.fetchStatus).toBe('idle'));
  expectWarnings(2);expect(screen.getByTestId(TASK)).toHaveStyle({color:'#dc2626'});
 });
 it('does not paint the previous settings revision while the new revision assessment is pending',async()=>{
  const ui=refreshExample();await waitFor(()=>expectWarnings(2));
  act(()=>ui.client.setQueryData(planningCheckKeys.settings(anna.id,alpha.id,PROJECT_ID),{...settings,revision:3} satisfies PlanningCheckSettingsDto));
  await waitFor(()=>expect(ui.assessmentCalls()).toBeGreaterThanOrEqual(2));
  expect(screen.getByTestId(TASK)).toHaveTextContent('neutral');expect(screen.getByTestId(SECOND_TASK)).toHaveTextContent('neutral');
  expect(screen.getByTestId('group')).not.toHaveTextContent('Estimate reminder');
  ui.assessmentRefresh.resolve(ok({...ui.confirmed,settingsRevision:3}));await waitFor(()=>expectWarnings(2));
 });
 it('clears retained colors and counts on a failed refresh instead of presenting stale warnings as current',async()=>{
  const ui=refreshExample();await waitFor(()=>expectWarnings(2));
  act(()=>{void ui.client.invalidateQueries({queryKey:[...planningCheckKeys.root(anna.id,alpha.id,PROJECT_ID),'assessment']});});
  await waitFor(()=>expect(ui.assessmentCalls()).toBeGreaterThanOrEqual(2));expectWarnings(2);
  ui.assessmentRefresh.resolve(failure(503,'UNAVAILABLE','Synthetic refresh failure'));
  await screen.findByRole('alert');expect(screen.getByTestId(TASK)).toHaveTextContent('neutral');expect(screen.getByTestId('group')).not.toHaveTextContent('Estimate reminder');
 });
 it('hides retained warnings immediately when current authority is invalidated, even during refresh',async()=>{
  const ui=refreshExample();await waitFor(()=>expectWarnings(2));
  act(()=>{void ui.client.invalidateQueries({queryKey:[...planningCheckKeys.root(anna.id,alpha.id,PROJECT_ID),'assessment']});});
  await waitFor(()=>expect(ui.assessmentCalls()).toBeGreaterThanOrEqual(2));expectWarnings(2);
  act(()=>{void ui.client.invalidateQueries({queryKey:queryKeys.workspace(anna.id,alpha.id),exact:true});});
  expect(screen.getByTestId(TASK)).toHaveTextContent('neutral');expect(screen.getByTestId('group')).not.toHaveTextContent('Estimate reminder');
 });
 it('does not carry warnings into another project or a disabled view',async()=>{
  const ui=refreshExample();await waitFor(()=>expectWarnings(2));
  ui.rerenderScope(PROJECT_ID,false);expect(screen.getByTestId(TASK)).toHaveTextContent('neutral');expect(screen.getByTestId('group')).not.toHaveTextContent('Estimate reminder');
  ui.rerenderScope(OTHER_PROJECT);await waitFor(()=>expect(ui.api.calls.some(call=>call.method==='POST'&&call.path.includes(OTHER_PROJECT))).toBe(true));
  expect(screen.getByTestId(TASK)).toHaveTextContent('neutral');expect(screen.getByTestId(SECOND_TASK)).toHaveTextContent('neutral');expect(screen.getByTestId('group')).not.toHaveTextContent('Estimate reminder');
 });
});

it('does not request a full-project assessment for disabled settings, while the owner can still configure them',async()=>{const client=createQueryClient({retry:false}),prefix=`/api/v1/workspaces/${alpha.id}/projects/${PROJECT_ID}/planning-checks`;client.setQueryData(queryKeys.me,{actor:anna});client.setQueryData(queryKeys.workspace(anna.id,alpha.id),alpha);client.setQueryData(queryKeys.project(anna.id,alpha.id,PROJECT_ID),project(alpha.id,PROJECT_ID,'Disabled checks'));const{calls}=installFakeApi({[`GET ${prefix}/settings`]:()=>ok({...settings,config:{...settings.config,enabled:false}})});function Harness(){const checks=useProjectPlanningChecks({actorId:anna.id,workspaceId:alpha.id,projectId:PROJECT_ID,projectRevision:1,fields:[field('Allowance','duration')],members:[],sections:[],tags:[],enabled:true,writable:true,requestedOpen:false,onOpenTask:()=>undefined});return<MemoryRouter>{checks.control}{checks.dialogs}<span data-testid="disabled-advisory">{checks.fieldAdvisory({...task,id:TASK,projectId:PROJECT_ID},field('Allowance','duration'))?.label??'neutral'}</span></MemoryRouter>;}const ui=renderFieldUi(<Harness/>,client);await waitFor(()=>expect(screen.getByRole('button',{name:'Checks'})).toBeEnabled());expect(screen.getByTestId('disabled-advisory')).toHaveTextContent('neutral');expect(calls.filter(call=>call.method==='POST')).toHaveLength(0);await ui.user.click(screen.getByRole('button',{name:'Checks'}));expect(screen.getByRole('checkbox',{name:'Enable planning checks'})).not.toBeChecked();expect(calls.filter(call=>call.method==='POST')).toHaveLength(0);});
