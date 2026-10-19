import type { GenericMeasureResultDto, GenericReportNumberDto, GenericReportResultDto } from '@workloom/contracts';
import { fireEvent, render as renderBase, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { ReportResults } from './ReportResults';
import { amount, result, plan } from './test/fixtures';
import { field } from '../fields/test/fixtures';
import { alpha, alphaMembers } from '../../test/fakeApi';
function render(ui: Parameters<typeof renderBase>[0]) { const view=renderBase(ui); const summary=screen.getByText('Coverage and calculation details'),details=summary.closest('details'); if(!details)throw new Error('Missing calculation disclosure');details.open=true;fireEvent(details,new Event('toggle'));return view; }
describe('aggregate duration results', () => {
  it('renders negative current and original differences without applying task-value validation', () => {
    const source = result();
    if (!source.comparison) throw new Error('Missing comparison fixture');
    render(<MemoryRouter><ReportResults workspaceId={alpha.id} members={alphaMembers} sections={[]} result={{ ...source, comparison: { ...source.comparison, plan: amount(600), fact: amount(200), difference: amount(-400) } }}/></MemoryRouter>);
    expect(screen.getByRole('region', { name: 'Results' })).toHaveTextContent('-6h 40m');
    expect(screen.getByText('Current plan vs current actual · paired tasks')).toBeVisible();
  });
  it('renders whole-minute sums above every per-task limit and keeps arbitrary precision', () => {
    const source = result(), measure = source.measures[0];
    if (!measure) throw new Error('Missing measure fixture');
    render(<MemoryRouter><ReportResults workspaceId={alpha.id} members={alphaMembers} sections={[]} result={{ ...source, comparison: null, measures: [{ ...measure, value: { numerator: '9007199254740993001', denominator: '1', decimal: '9007199254740993001' } }] }}/></MemoryRouter>);
    expect(screen.getByTitle('9007199254740993001/1 (9007199254740993001)')).toHaveTextContent('150119987579016550h 1m');
  });
});

function grouped(groupValue: GenericReportNumberDto | null, wholeValue: GenericReportNumberDto | null, filled = 1): GenericReportResultDto {
  const source = result(), measure = source.measures[0];
  if (!measure) throw new Error('Missing aggregate fixture');
  return { ...source, comparison: null, config: { ...source.config, comparison: null, groupBy: { kind: 'assignee' } }, measures: [{ ...measure, value: wholeValue }], groups: [{ key: 'unassigned', label: 'Unassigned', taskCount: 3, measures: [{ ...measure, value: groupValue, coverage: { tasks: 3, filled, zero: groupValue?.numerator === '0' ? 1 : 0, missing: 3 - filled, null: 0 } }], comparison: null, initialComparison: null }] };
}
function report(source: GenericReportResultDto) { return <MemoryRouter><ReportResults workspaceId={alpha.id} members={alphaMembers} sections={[]} result={source}/></MemoryRouter>; }

describe('recorded duration shares', () => {
  it('uses full-scope sums including Uncategorized, preserves partial coverage, and follows stable IDs after rename', () => {
    const source = grouped(amount(25), amount(100));
    const category = { ...field('Work type', 'single_select', '90000000-0000-4000-8000-000000000003'), options: [{ id: '91000000-0000-4000-8000-000000000003', name: 'Discovery', color: null, position: 0, revision: 1, archivedAt: null }] };
    const unassigned = source.groups[0]; if (!unassigned) throw new Error('Missing group');
    const firstMeasure = unassigned.measures[0]; if (!firstMeasure) throw new Error('Missing group measure');
    const categorized = { ...source, config: { ...source.config, groupBy: { kind: 'category' as const, fieldId: category.id } }, fields: [...source.fields, category], groups: [{ ...unassigned, key: category.options[0]?.id ?? '', label: 'Stale type label', measures: [{ ...firstMeasure, value: amount(75) }] }, { ...unassigned, key: 'uncategorized', label: 'Uncategorized' }] };
    const ui = render(report(categorized));
    expect(screen.getByRole('img', { name: 'Budget: 75% of recorded time. Exact share: 7500/100%.' })).toBeVisible();
    expect(screen.getByRole('img', { name: 'Budget: 25% of recorded time. Exact share: 2500/100%.' })).toBeVisible();
    expect(screen.getByText('Uncategorized · 3 tasks')).toBeVisible();
    expect(screen.getByText('Discovery · 3 tasks')).toBeVisible();
    expect(screen.getByText(/Missing and cleared values are excluded; percentages describe recorded time only/)).toBeVisible();
    expect(categorized.rows).toHaveLength(1); // Detail page has one tiny value; the denominator remains the server's complete scope.
    ui.rerender(report({ ...categorized, fields: categorized.fields.map(item => item.id === plan.id ? { ...item, name: 'Renamed duration' } : item) }));
    expect(screen.getByRole('img', { name: 'Renamed duration: 25% of recorded time. Exact share: 2500/100%.' })).toBeVisible();
    expect(screen.queryByRole('img', { name: /^Budget:/ })).not.toBeInTheDocument();
  });

  it.each([
    { name: 'missing group', group: null, whole: amount(100), filled: 0 },
    { name: 'missing whole', group: amount(10), whole: null, filled: 1 },
    { name: 'zero denominator', group: amount(0), whole: amount(0), filled: 1 },
    { name: 'all-missing group', group: amount(0), whole: amount(100), filled: 0 },
  ])('keeps $name unknown rather than turning it into zero percent', ({ group, whole, filled }) => {
    render(report(grouped(group, whole, filled)));
    expect(screen.getByRole('img', { name: 'Budget: share of recorded time unavailable.' })).toBeVisible();
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
  });

  it('distinguishes recorded zero from a tiny positive share and preserves the exact accessible fraction', () => {
    const ui = render(report(grouped(amount(0), amount(100000))));
    expect(screen.getByRole('img', { name: 'Budget: 0% of recorded time. Exact share: 0/100000%.' })).toBeVisible();
    ui.rerender(report(grouped(amount(1), amount(100000))));
    expect(screen.getByRole('img', { name: 'Budget: ≈0% of recorded time. Exact share: 100/100000%.' })).toBeVisible();
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
    expect(screen.getByText('≈0%')).toBeVisible();
  });

  it('calculates arbitrary-precision shares without using rounded decimals or loaded rows', () => {
    render(report(grouped({ numerator: '9007199254740993001', denominator: '1', decimal: '9007199254740993001' }, { numerator: '18014398509481986002', denominator: '1', decimal: '18014398509481986002' })));
    expect(screen.getByRole('img', { name: 'Budget: 50% of recorded time. Exact share: 900719925474099300100/18014398509481986002%.' })).toBeVisible();
  });

  it('does not invent shares for averages or an aggregate with a different field identity', () => {
    const source = grouped(amount(25), amount(100)), group = source.groups[0]; if (!group) throw new Error('Missing group');
    const measure = group.measures[0]; if (!measure) throw new Error('Missing group measure');
    const average: GenericMeasureResultDto = { ...measure, key: 'average', operation: 'avg' };
    render(report({ ...source, groups: [{ ...group, measures: [{ ...measure, fieldId: '90000000-0000-4000-8000-000000000099' }, average] }] }));
    expect(screen.getAllByRole('img')).toHaveLength(1);
    expect(screen.getByRole('img', { name: 'Unavailable or deleted field: share of recorded time unavailable.' })).toBeVisible();
    expect(screen.queryByText('25%')).not.toBeInTheDocument();
  });
});

describe('compact exact aggregate formatting', () => {
  it.each([
    { numerator: '1', denominator: '8', decimal: '0.125', shown: '≈0.13' },
    { numerator: '-1', denominator: '8', decimal: '-0.125', shown: '≈-0.13' },
    { numerator: '1', denominator: '4', decimal: '0.25', shown: '0.25' },
    { numerator: '-9007199254740993001', denominator: '3', decimal: '-3002399751580331000.333333333333', shown: '≈-3002399751580331000.33' },
  ])('rounds $numerator/$denominator at most twice with exact source information', ({ numerator, denominator, decimal, shown }) => {
    const source = result(), measure = source.measures[0]; if (!measure) throw new Error('Missing measure');
    render(report({ ...source, comparison: null, measures: [{ ...measure, operation: 'avg', unit: 'number', value: { numerator, denominator, decimal } }] }));
    expect(screen.getByText(shown)).toBeVisible();
    expect(screen.getByTitle(`${numerator}/${denominator} (${decimal})`)).toBeVisible();
  });

  it('marks a nonzero average rounded to zero and retains exact zero without an approximation marker', () => {
    const source = result(), measure = source.measures[0]; if (!measure) throw new Error('Missing measure');
    const ui = render(report({ ...source, comparison: null, measures: [{ ...measure, operation: 'avg', value: { numerator: '1', denominator: '1000', decimal: '0.001' } }] }));
    expect(screen.getByText('≈0 minutes')).toBeVisible();
    ui.rerender(report({ ...source, comparison: null, measures: [{ ...measure, operation: 'avg', value: amount(0) }] }));
    expect(screen.getByText('0m')).toBeVisible(); expect(screen.queryByText('≈0m')).not.toBeInTheDocument();
  });
});
