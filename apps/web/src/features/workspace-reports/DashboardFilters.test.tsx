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
