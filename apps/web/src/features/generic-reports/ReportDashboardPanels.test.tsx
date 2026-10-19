import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ReportDashboardPanels } from './ReportDashboardPanels';
import { renderFieldUi, field } from '../fields/test/fixtures';
import { alpha, anna, alphaMembers, installFakeApi, ok } from '../../test/fakeApi';
import { definition, result, rootPath, PROJECT_ID } from './test/fixtures';
import type { GenericReportConfig } from '@workloom/contracts';
describe('authoritative secondary report breakdowns',()=>{
 it('preserves task filters and one canonical task source while omitting unrelated private capacity reads',async()=>{
  const original=result(),category=field('Work type','single_select','90000000-0000-4000-8000-000000000033'),config:GenericReportConfig={...definition().config,groupBy:{kind:'category',fieldId:category.id},capacity:{startDate:'2026-10-01',endDate:'2026-10-31',people:{kind:'selected',membershipIds:['99999999-9999-4999-8999-999999999999']}}};
  const {calls}=installFakeApi({[`POST ${rootPath}/projects/${PROJECT_ID}/field-aggregates`]:request=>ok({...original,reportId:null,definitionRevision:null,config:(request.body as {config:GenericReportConfig}).config,groups:[{key:alphaMembers[0]?.id??'unassigned',label:'Person',taskCount:63,measures:original.measures,comparison:original.comparison,initialComparison:null}]})});
  const callback=vi.fn();renderFieldUi(<ReportDashboardPanels actorId={anna.id} workspaceId={alpha.id} projectId={PROJECT_ID} result={{...original,config,fields:[...original.fields,category]}} members={alphaMembers} sections={[]} fields={[category]} disabled onPersonSelect={callback}/>);
  await screen.findByRole('region',{name:'Plan and actual by primary assignee'});await waitFor(()=>expect(calls).toHaveLength(1));
  expect(calls[0]?.body).toMatchObject({config:{projectId:PROJECT_ID,filters:config.filters,groupBy:{kind:'assignee'}},offset:0,limit:1});
  expect((calls[0]?.body as {config:GenericReportConfig}).config.capacity).toBeUndefined();
  expect(screen.queryByRole('button',{name:/Show tasks for/})).not.toBeInTheDocument();
  expect(original.rows).toHaveLength(1);expect(screen.getByText('Paired coverage: 7 of 8 eligible tasks in the full scope.')).toBeVisible();expect(callback).not.toHaveBeenCalled();
 });
});
