import { screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import type { GenericAggregateSettingsDto, QueryGenericAggregatesInput, SetGenericAggregateSettingsInput } from '@workloom/contracts';
import { alpha, installFakeApi, ok, renderApp } from '../../test/fakeApi';
import { PROJECT_ID, amount, coverage, definition, plan, result, rootPath, routes, tablePath } from './test/fixtures';
beforeAll(async () => { await import('../../routes/ProjectPage'); });
describe('inline authoritative table aggregate controls', () => {
 it('changes a footer calculation immediately, renders the same operation in each aligned group cell and persists None', async () => {
  let settings:GenericAggregateSettingsDto = {workspaceId:alpha.id,projectId:PROJECT_ID,revision:2,measures:definition().config.measures};
  const {calls}=installFakeApi(routes({
   [`GET ${rootPath}/projects/${PROJECT_ID}/field-aggregate-settings`]:()=>ok(settings),
   [`PUT ${rootPath}/projects/${PROJECT_ID}/field-aggregate-settings`]:request=>{const input=request.body as SetGenericAggregateSettingsInput;expect(input.expectedRevision).toBe(settings.revision);settings={...settings,revision:settings.revision+1,measures:input.measures};return ok(settings);},
   [`POST ${rootPath}/projects/${PROJECT_ID}/field-aggregates`]:request=>{const input=request.body as QueryGenericAggregatesInput;const measures=input.config.measures.map(measure=>({key:measure.key,operation:measure.operation,fieldId:'fieldId'in measure?measure.fieldId:null,unit:'minutes' as const,value:amount(measure.operation==='avg'?60:1131),coverage}));return ok({...result(),reportId:null,definitionRevision:null,config:input.config,measures,groups:[{key:'no_section',label:'No section',taskCount:63,measures,comparison:null,initialComparison:null}]});},
  }));
  const{user}=renderApp(tablePath);await waitFor(()=>expect(document.querySelector('tfoot')).toHaveTextContent('18h 51m'));
  const footer=within(document.querySelector('tfoot') as HTMLElement);
  await user.click(footer.getByRole('button',{name:'Calculation for Budget'}));await user.click(screen.getByRole('menuitemradio',{name:'Average'}));
  await waitFor(()=>expect(document.querySelector('tfoot')).toHaveTextContent('1h'));
  expect(settings.measures).toEqual([{key:'budget',operation:'avg',fieldId:plan.id}]);
  expect(document.querySelector('[data-task-group-aggregates]')).toHaveTextContent('Average1h');
  expect(document.querySelector('[data-task-project-aggregates]')?.children.length).toBe(document.querySelector('thead tr')?.children.length);
  await user.click(footer.getByRole('button',{name:'Calculation for Budget'}));await user.click(screen.getByRole('menuitemradio',{name:'None'}));
  await waitFor(()=>expect(settings.measures).toEqual([]));await waitFor(()=>expect(footer.getByRole('button',{name:'Calculation for Budget'})).toHaveTextContent('Calculate'));
  expect(calls.filter(call=>call.method==='PUT')).toHaveLength(2);
 });
});
