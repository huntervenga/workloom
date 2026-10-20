import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DashboardFilters } from './DashboardFilters';
import { discovery } from './test/fixtures';
import { defaultDashboardInput } from './state';
it('choosing a saved report with a missing category starts with an explicit no-category mapping', async () => {
  const data = discovery(), source = data.sources[0]; if (!source) throw new Error('fixture');
  const id = 'ed000000-0000-4000-8000-000000000099';
  data.sources.push({ ...source, report: { ...source.report, id, name: 'Stale category report', config: { ...source.report.config, groupBy: { kind: 'category', fieldId: id } } } });
  const input = defaultDashboardInput(data); if (!input) throw new Error('fixture');
  const apply = vi.fn(), user = userEvent.setup();
  render(<DashboardFilters discovery={data} input={input} busy={false} onApply={apply} onReset={() => undefined} sourcesOpen onSourcesOpenChange={() => undefined}/>);
  await user.click(screen.getByRole('combobox', { name: 'Report for Delivery' })); await user.click(screen.getByRole('option', { name: 'Stale category report' }));
  await user.click(screen.getByRole('button', { name: 'Apply' }));
  expect(apply.mock.calls[0]?.[0].sources).toEqual([{ reportId: id, expectedRevision: 1, categoryFieldId: null }]);
});
describe('dashboard source control', () => {
  it('shows a restored multiple-person scope and can explicitly broaden it to all active people', async () => {
    const data = discovery(), base = defaultDashboardInput(data); if (!base) throw new Error('fixture');
    const apply = vi.fn(), user = userEvent.setup();
    render(<DashboardFilters discovery={data} input={{ ...base, people: { kind: 'selected', membershipIds: data.members.slice(0, 2).map(person => person.membershipId) } }} busy={false} onApply={apply} onReset={() => undefined} sourcesOpen={false} onSourcesOpenChange={() => undefined}/>);
    expect(screen.getByRole('combobox', { name: 'People' })).toHaveTextContent('2 selected people');
    await user.click(screen.getByRole('combobox', { name: 'People' })); await user.click(screen.getByRole('option', { name: 'All active people' })); await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(apply.mock.calls[0]?.[0].people).toEqual({ kind: 'all_active' });
  });
  it('validates an empty source selection without publishing a broader replacement', async () => {
    const data = discovery(), input = defaultDashboardInput(data); if (!input) throw new Error('fixture');
    const apply = vi.fn(), user = userEvent.setup();
    render(<DashboardFilters discovery={data} input={input} busy={false} onApply={apply} onReset={() => undefined} sourcesOpen onSourcesOpenChange={() => undefined}/>);
    await user.click(screen.getByRole('checkbox', { name: 'Include Delivery' })); await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(screen.getByRole('alert')).toHaveTextContent('at least one report source'); expect(apply).not.toHaveBeenCalled();
  });
});

it('uses the trusted workspace date and week start for an explicit current-week action, preserving sources and people', async()=>{
 const data=discovery(),base=defaultDashboardInput(data);if(!base)throw Error('fixture');const apply=vi.fn(),user=userEvent.setup();
 render(<DashboardFilters discovery={data} input={base} weekStart={7} busy={false} onApply={apply} onReset={()=>undefined} sourcesOpen={false} onSourcesOpenChange={()=>undefined}/>);
 await user.click(screen.getByRole('button',{name:'This week'}));expect(apply).toHaveBeenCalledWith({...base,range:{from:'2026-10-18',to:'2026-10-24'}});expect(base.range).not.toEqual({from:'2026-10-18',to:'2026-10-24'});
});

it('selects participant attribution explicitly and removes it again without changing field mappings',async()=>{
 const data=discovery(),input=defaultDashboardInput(data);if(!input)throw Error('fixture');const apply=vi.fn(),user=userEvent.setup();
 render(<DashboardFilters discovery={data} input={input} busy={false} onApply={apply} onReset={()=>undefined} sourcesOpen={false} onSourcesOpenChange={()=>undefined}/>);
 await user.click(screen.getByRole('combobox',{name:'Time attribution'}));await user.click(screen.getByRole('option',{name:'Personal effort'}));await user.click(screen.getByRole('button',{name:'Apply'}));
 expect(apply.mock.calls[0]?.[0]).toEqual({...input,attribution:'personal_effort'});
 await user.click(screen.getByRole('combobox',{name:'Time attribution'}));await user.click(screen.getByRole('option',{name:'Task values'}));await user.click(screen.getByRole('button',{name:'Apply'}));expect(apply.mock.calls[1]?.[0]).toEqual(input);
});
