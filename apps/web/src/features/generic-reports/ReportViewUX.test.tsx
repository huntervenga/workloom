import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useNavigate } from 'react-router';
import userEvent from '@testing-library/user-event';
import { AppRoutes } from '../../app/AppRoutes';
import { SessionProvider } from '../../app/session';
import { createQueryClient } from '../../lib/queryClient';
import { protectedDraftsFor } from '../../lib/protectedDrafts';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { installFakeApi, ok, renderApp } from '../../test/fakeApi';
import { heldResponse } from '../fields/test/fixtures';
import { definition, reportPath, result, routes, tablePath, uiPath, PROJECT_ID } from './test/fixtures';
beforeAll(async()=>{await import('../../routes/ReportsPage');});
async function choose(user:ReturnType<typeof renderApp>['user'],label:string,option:string){await user.click(screen.getByRole('combobox',{name:label}));await user.click(within(screen.getByRole('listbox',{name:label})).getByRole('option',{name:option}));}
describe('project Reports working view',()=>{
 it('opens the first saved report with the same project title and view navigation, without a write',async()=>{
  const {calls}=installFakeApi(routes());renderApp(uiPath);await screen.findByRole('heading',{name:'Results'});
  const nav=screen.getByRole('navigation',{name:'Project views'});
  expect(within(nav).getByRole('link',{name:'Tasks'})).toHaveAttribute('href',tablePath);
  expect(within(nav).getByRole('link',{name:'Board'})).toHaveAttribute('href',`${tablePath}?view=board`);
  expect(within(nav).getByRole('link',{name:'Timeline'})).toHaveAttribute('href',`${tablePath}?view=gantt`);
  expect(within(nav).getByRole('link',{name:'Reports'})).toHaveAttribute('aria-current','page');
  expect(screen.getByRole('heading',{name:'Budget review'})).toBeVisible();
  expect(screen.getByText('Templates and setup').closest('details')).not.toHaveAttribute('open');
  expect(calls.filter(c=>c.method!=='GET'&&!c.path.endsWith('/query')&&!c.path.endsWith('/field-aggregates'))).toHaveLength(0);
 });
 it('sends a temporary person filter to the server across the full scope, leaving the saved definition unchanged',async()=>{
  const {calls}=installFakeApi(routes({[`POST ${reportPath.replace('/generic-reports',`/projects/${PROJECT_ID}/field-aggregates`)}`]:request=>ok({...result(),config:(request.body as {config:ReturnType<typeof definition>['config']}).config})}));
  const {user}=renderApp(uiPath);await screen.findByRole('heading',{name:'Results'});
  await choose(user,'People','Unassigned');await user.click(screen.getByRole('button',{name:'Apply filters'}));
  await waitFor(()=>expect(calls.some(c=>c.path.endsWith('/field-aggregates') && (c.body as {config?:{filters?:{assignee?:{kind:string}}}}).config?.filters?.assignee?.kind==='unassigned')).toBe(true));
  const read=calls.find(c=>c.path.endsWith('/field-aggregates') && (c.body as {config?:{filters?:{assignee?:{kind:string}}}}).config?.filters?.assignee?.kind==='unassigned');
  expect(read?.body).toMatchObject({config:{filters:{assignee:{kind:'unassigned'}}},offset:0,limit:100});
  expect(calls.some(c=>c.method==='PATCH')).toBe(false);
  await user.click(screen.getByRole('button',{name:'Saved scope'}));
  expect(screen.getByRole('combobox',{name:'People'})).toHaveTextContent('Everyone');
 });
 it('retains the loaded dashboard while an ordinary background refresh is pending',async()=>{
  const gate=heldResponse();let reads=0;
  installFakeApi(routes({[`POST ${reportPath}/${definition().id}/query`]:()=>{reads++;return reads>1?gate.promise:ok(result());}}));
  const {user}=renderApp(uiPath);await screen.findByRole('heading',{name:'Results'});
  await user.click(screen.getByRole('button',{name:'Run report'}));
  await waitFor(()=>expect(reads).toBeGreaterThan(1));expect(screen.getByRole('heading',{name:'Results'})).toBeVisible();
  expect(screen.getByRole('navigation',{name:'Project views'})).toBeVisible();
  await act(async()=>gate.lose());
 });
});

function navigationFixture(){const first=definition(),second={...first,id:'ed000000-0000-4000-8000-000000000099',name:'Second report'};const api=installFakeApi(routes({[`GET ${reportPath}`]:()=>ok([first,second]),[`GET ${reportPath}/${second.id}`]:()=>ok(second),[`GET ${reportPath}/${second.id}/initial-snapshots`]:()=>ok([]),[`POST ${reportPath}/${second.id}/query`]:()=>ok({...result(),reportId:second.id,config:second.config})}));const client=createQueryClient({retry:false});function Navigation(){const navigate=useNavigate();return <><button onClick={()=>void navigate(`${uiPath}?report=${second.id}`)}>Open second</button><button onClick={()=>void navigate(-1)}>Go back</button></>;}render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`${uiPath}?report=${first.id}`]}><SessionProvider><Navigation/><AppRoutes/></SessionProvider></MemoryRouter></QueryClientProvider>);return {...api,user:userEvent.setup({pointerEventsCheck:0}),client};}
describe('report identity across same-route history',()=>{
 it('resets temporary filters, pagination and snapshot selection when moving to another report and Back',async()=>{const {user,calls}=navigationFixture();await screen.findByRole('heading',{name:'Budget review'});await choose(user,'People','Unassigned');await user.click(screen.getByRole('button',{name:'Apply filters'}));await screen.findByText('Temporary view filters · the saved report is unchanged.');await user.click(screen.getByRole('button',{name:'Open second'}));await screen.findByRole('heading',{name:'Second report'});expect(screen.getByRole('combobox',{name:'People'})).toHaveTextContent('Everyone');const request=calls.find(c=>c.path.includes('000000000099/query'));expect(request?.body).toMatchObject({offset:0,snapshotId:null});await user.click(screen.getByRole('button',{name:'Go back'}));await screen.findByRole('heading',{name:'Budget review'});expect(screen.getByRole('combobox',{name:'People'})).toHaveTextContent('Everyone');});
 it('retains a protected editor when the URL changes and opens the requested report only after explicit discard',async()=>{const {user}=navigationFixture();await screen.findByRole('heading',{name:'Budget review'});await user.click(screen.getByRole('button',{name:'Edit report'}));const input=screen.getByRole('textbox',{name:'Report name'});await user.clear(input);await user.type(input,'Unsent changes');await user.click(screen.getByRole('button',{name:'Open second'}));expect(screen.getByRole('textbox',{name:'Report name'})).toHaveValue('Unsent changes');expect(screen.getByText('Finish or discard changes to this report before opening the requested report.')).toBeVisible();await user.click(screen.getByRole('button',{name:'Discard changes'}));await screen.findByRole('heading',{name:'Second report'});});
 it('explicitly cancels a snapshot draft without leaving hidden protection or losing later navigation',async()=>{const {user,client}=navigationFixture();await screen.findByRole('heading',{name:'Budget review'});await user.click(screen.getByText('Initial plan snapshots'));await user.click(screen.getByRole('button',{name:'Capture initial snapshot'}));await user.type(screen.getByRole('textbox',{name:'Snapshot name'}),'Draft agreement');expect(protectedDraftsFor(client).protecting).toBe(true);await user.click(screen.getByRole('button',{name:'Cancel'}));await waitFor(()=>expect(protectedDraftsFor(client).protecting).toBe(false));await user.click(screen.getByRole('button',{name:'Open second'}));await screen.findByRole('heading',{name:'Second report'});expect(screen.queryByText('Finish or discard changes to this report before opening the requested report.')).not.toBeInTheDocument();});
});
