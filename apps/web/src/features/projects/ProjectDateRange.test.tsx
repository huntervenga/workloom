import { screen, waitFor, within } from '@testing-library/react';
import { beforeAll, expect, it } from 'vitest';
import type { UpdateProjectInput } from '@workloom/contracts';
import { alpha, installFakeApi, ok, project, renderApp } from '../../test/fakeApi';
import { PROJECT_ID, rootPath, routes, tablePath } from '../generic-reports/test/fixtures';
beforeAll(async()=>{await import('../../routes/ProjectPage');});
it('persists optional project dates through a captured project revision and can clear them without rescheduling tasks',async()=>{
 let current=project(alpha.id,PROJECT_ID,'Optional date bounds');
 const {calls}=installFakeApi(routes({[`GET ${rootPath}/projects/${PROJECT_ID}`]:()=>ok(current),[`PATCH ${rootPath}/projects/${PROJECT_ID}`]:request=>{const input=request.body as UpdateProjectInput;expect(input.expectedRevision).toBe(current.revision);current={...current,revision:current.revision+1,dateRange:input.dateRange??null};return ok(current);}}));
 const {user}=renderApp(tablePath);await user.click(await screen.findByRole('button',{name:'Project dates'}));let dialog=screen.getByRole('dialog',{name:'Project dates'});
 await user.type(within(dialog).getByLabelText('From (inclusive)'),'2026-10-05');await user.type(within(dialog).getByLabelText('To (inclusive)'),'2026-10-16');await user.click(within(dialog).getByRole('button',{name:'Save project dates'}));
 await waitFor(()=>expect(screen.queryByRole('dialog',{name:'Project dates'})).not.toBeInTheDocument());await user.click(screen.getByRole('button',{name:'2026-10-05 – 2026-10-16'}));dialog=screen.getByRole('dialog',{name:'Project dates'});await user.click(within(dialog).getByRole('button',{name:'Clear project dates'}));await user.click(within(dialog).getByRole('button',{name:'Save project dates'}));await waitFor(()=>expect(current.dateRange).toBeNull());
 expect(calls.filter(call=>call.method==='PATCH').map(call=>call.body)).toEqual([{expectedRevision:1,dateRange:{from:'2026-10-05',to:'2026-10-16'}},{expectedRevision:2,dateRange:null}]);expect(calls.some(call=>call.path.includes('/tasks/')&&call.method!=='GET')).toBe(false);
});
