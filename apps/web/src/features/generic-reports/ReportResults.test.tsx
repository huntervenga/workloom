import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { ReportResults } from './ReportResults';
import { amount, result } from './test/fixtures';
import { alpha, alphaMembers } from '../../test/fakeApi';
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
    expect(within(screen.getByRole('region', { name: 'Results' })).getByText('150119987579016550h 1m')).toBeVisible();
  });
});
