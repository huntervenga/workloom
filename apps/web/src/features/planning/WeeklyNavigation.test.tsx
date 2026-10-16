import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import type * as WeeklyReportExports from './WeeklyReport';
import type * as WorkTypeReportExports from '../work-categories/WorkTypeReport';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from '../../app/AppRoutes';
import { SessionProvider } from '../../app/session';
import { alphaMembers, created, deferred, installFakeApi, ok } from '../../test/fakeApi';
import { renderFieldUi } from '../fields/test/fixtures';
import { categoryReport, TYPE_RUN } from '../work-categories/test/fixtures';
import { PERIOD_A, PERIOD_B, RUN_ID, baseline, report, rootPath, routes, weekPath } from './test/fixtures';

const completion=vi.hoisted(()=>({weekly:null as null|((id:string,period:string,source:string)=>void),types:null as null|((id:string,period:string,source:string)=>void)}));
// Keep the real report UI/queries. Retain the actual page callback to deliver a completion
// at the router-head/React-render boundary deterministically, rather than adding sleeps.
vi.mock('./WeeklyReport',async importOriginal=>{const actual=await importOriginal<typeof WeeklyReportExports>();return {...actual,WeeklyReport:(props:ComponentProps<typeof actual.WeeklyReport>)=>{completion.weekly=props.onCalculated;return <actual.WeeklyReport {...props}/>;}};});
vi.mock('../work-categories/WorkTypeReport',async importOriginal=>{const actual=await importOriginal<typeof WorkTypeReportExports>();return {...actual,WorkTypeReport:(props:ComponentProps<typeof actual.WorkTypeReport>)=>{completion.types=props.onCalculated;return <actual.WorkTypeReport {...props}/>;}};});
beforeAll(async()=>{await import('../../routes/WeeklyPage');});
function renderWeekly(search:string){const router=createMemoryRouter([{path:'*',element:<SessionProvider><AppRoutes/></SessionProvider>}],{initialEntries:[weekPath+search]});return {...renderFieldUi(<RouterProvider router={router}/>),router};}
function reportRoutes(){return {...routes(),[`GET ${rootPath}/periods/${PERIOD_A}/baselines`]:()=>ok([baseline()]),[`GET ${rootPath}/report-runs`]:()=>ok([report()]),[`GET ${rootPath}/report-runs/${RUN_ID}`]:()=>ok(report()),[`GET ${rootPath}/report-runs/${RUN_ID}/rows`]:()=>ok([]),[`GET ${rootPath}/work-type-report-runs`]:()=>ok([categoryReport()]),[`GET ${rootPath}/work-type-report-runs/${TYPE_RUN}`]:()=>ok(categoryReport()),[`GET ${rootPath}/work-type-report-runs/${TYPE_RUN}/rows`]:()=>ok([])};}

describe('Weekly event-time navigation',()=>{
 it.each(['person','view'] as const)('does not resurrect the old period or report IDs when an old %s control fires in the same batch',async control=>{
  const colleague=alphaMembers[1];if(!colleague)throw new Error('Missing colleague');const {calls}=installFakeApi(reportRoutes());const {router}=renderWeekly(`?period=${PERIOD_A}&view=plan&run=${RUN_ID}&typeRun=${TYPE_RUN}&series=f9000000-0000-4000-8000-000000000099#kept`);
  const period=await screen.findByLabelText('Period',{exact:true});const person=screen.getByLabelText('Time entry for');const view=screen.getByRole('button',{name:/^Work types$/});
  act(()=>{fireEvent.change(period,{target:{value:PERIOD_B}});if(control==='person')fireEvent.change(person,{target:{value:colleague.id}});else fireEvent.click(view);});
  const params=new URLSearchParams(router.state.location.search);expect(params.get('period')).toBe(PERIOD_B);expect(params.has('run')).toBe(false);expect(params.has('typeRun')).toBe(false);expect(params.get('series')).toBe('f9000000-0000-4000-8000-000000000099');expect(router.state.location.hash).toBe('#kept');if(control==='person')expect(params.get('worker')).toBe(colleague.id);else expect(params.get('view')).toBe('work-types');expect(calls.filter(call=>call.method!=='GET')).toHaveLength(0);
 });
 it.each([
  {view:'report',key:'run',source:RUN_ID,callback:'weekly' as const},
  {view:'work-types',key:'typeRun',source:TYPE_RUN,callback:'types' as const},
 ].flatMap(item=>(['period','view','run'] as const).map(change=>({...item,change}))))('ignores a late $view completion after a new $change router head before React renders it',async({view,key,source,callback,change})=>{
  installFakeApi(reportRoutes());const {router}=renderWeekly(`?period=${PERIOD_A}&view=${view}&${key}=${source}`);await screen.findByRole('button',{name:'Set up new report'});const finished=completion[callback];if(!finished)throw new Error('Missing page completion callback');
  const next=new URLSearchParams({period:PERIOD_A,view,[key]:source});if(change==='period')next.set('period',PERIOD_B);else if(change==='view')next.set('view','plan');else next.set(key,'f9000000-0000-4000-8000-000000000098');
  let chosenKey='';act(()=>{void router.navigate({pathname:weekPath,search:`?${next}`});chosenKey=router.state.location.key;finished('f9000000-0000-4000-8000-000000000097',PERIOD_A,source);expect(router.state.location.search).toBe(`?${next}`);expect(router.state.location.key).toBe(chosenKey);});
  expect(new URLSearchParams(router.state.location.search).get(change==='run'?key:change)).toBe(next.get(change==='run'?key:change));
 });
 it('resumes the held original report with one navigation clearing both stale report IDs and preserving the chosen time-entry person',async()=>{
  const colleague=alphaMembers[1];if(!colleague)throw new Error('Missing colleague');const gate=deferred<Response>();const {calls}=installFakeApi({...reportRoutes(),[`POST ${rootPath}/report-runs`]:()=>gate.promise});const {router,user}=renderWeekly(`?period=${PERIOD_A}&view=report&run=${RUN_ID}&typeRun=${TYPE_RUN}&worker=${colleague.id}`);await user.click(await screen.findByRole('button',{name:'Set up new report'}));await user.click(screen.getByRole('button',{name:'Calculate new report'}));await waitFor(()=>expect(calls.filter(call=>call.method==='POST')).toHaveLength(1));
  await act(async()=>{await router.navigate(`${weekPath}?period=${PERIOD_B}&view=work-types&run=${RUN_ID}&typeRun=${TYPE_RUN}&worker=${colleague.id}`);});await screen.findByRole('button',{name:'Open original save'});let navigations=0;const stop=router.subscribe(()=>{navigations++;});await user.click(screen.getByRole('button',{name:'Open original save'}));stop();
  const params=new URLSearchParams(router.state.location.search);expect(params.get('period')).toBe(PERIOD_A);expect(params.get('view')).toBe('report');expect(params.has('run')).toBe(false);expect(params.has('typeRun')).toBe(false);expect(params.get('worker')).toBe(colleague.id);expect(navigations).toBe(1);expect(calls.filter(call=>call.method==='POST')).toHaveLength(1);await act(async()=>gate.resolve(created(report())));
 });
 it('replaces the initial canonical period without adding a Back history entry',async()=>{
  installFakeApi(reportRoutes());const router=createMemoryRouter([{path:'*',element:<SessionProvider><AppRoutes/></SessionProvider>}],{initialEntries:['/w/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',weekPath+'?worker='+alphaMembers[1]?.id+'#kept'],initialIndex:1});renderFieldUi(<RouterProvider router={router}/>);await screen.findByLabelText('Period',{exact:true});await waitFor(()=>expect(new URLSearchParams(router.state.location.search).has('period')).toBe(true));expect(router.state.location.hash).toBe('#kept');expect(new URLSearchParams(router.state.location.search).get('worker')).toBe(alphaMembers[1]?.id);await act(async()=>{await router.navigate(-1);});expect(router.state.location.pathname).toBe('/w/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
 });
});
