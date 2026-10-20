import { screen, waitFor, within } from '@testing-library/react';
import { beforeAll, expect, it } from 'vitest';
import type { QueryGenericAggregatesInput } from '@workloom/contracts';
import { alpha, installFakeApi, ok, project, renderApp } from '../../test/fakeApi';
import { definition, PROJECT_ID, reportPath, result, rootPath, routes, snapshot, uiPath } from './test/fixtures';
beforeAll(async()=>{await import('../../routes/ReportsPage');});
it('inherits existing project dates in a read-only view without changing task dates or capturing derived settings',async()=>{
 const saved=definition(),original=structuredClone(saved.config),initial=snapshot();
 const{calls}=installFakeApi(routes({[`GET ${rootPath}/projects/${PROJECT_ID}`]:()=>ok({...project(alpha.id,PROJECT_ID,'Project period'),dateRange:{from:'2026-10-19',to:'2026-10-25'}}),[`GET ${reportPath}/${saved.id}/initial-snapshots`]:()=>ok([initial]),[`POST ${rootPath}/projects/${PROJECT_ID}/field-aggregates`]:request=>ok({...result(),config:(request.body as QueryGenericAggregatesInput).config})}));
 const{user}=renderApp(uiPath);await screen.findByRole('heading',{name:'Results'});const period=screen.getByRole('combobox',{name:'Available hours period'});expect(period.closest('[data-report-toolbar]')).not.toBeNull();await user.click(screen.getByLabelText('Available hours period · Task scope'));expect(screen.getByText('Available: 2026-10-19 – 2026-10-25 · Project dates')).toBeVisible();
 const query=calls.find(call=>call.path.endsWith('/field-aggregates')&&(call.body as QueryGenericAggregatesInput).limit===100);expect(query?.body).toMatchObject({config:{capacity:{startDate:'2026-10-19',endDate:'2026-10-25',people:{kind:'all_active'}},filters:{dateRange:null}}});
 await user.click(screen.getByText('Initial plan snapshots'));expect(screen.getByRole('button',{name:'Capture initial snapshot'})).toBeDisabled();expect(screen.getByText(/Available hours use a temporary period/)).toBeVisible();
 await user.click(screen.getByRole('combobox',{name:'Initial snapshot'}));await user.click(within(screen.getByRole('listbox',{name:'Initial snapshot'})).getByRole('option',{name:'Initial scope'}));
 await waitFor(()=>expect(calls.some(call=>call.path.endsWith(`/${saved.id}/query`)&&(call.body as{snapshotId?:string}).snapshotId===initial.id)).toBe(true));expect(screen.queryByRole('region',{name:'Available hours period'})).not.toBeInTheDocument();
 expect(saved.config).toEqual(original);expect(calls.filter(call=>call.method!=='GET'&&!call.path.endsWith('/query')&&!call.path.endsWith('/field-aggregates'))).toHaveLength(0);
});
