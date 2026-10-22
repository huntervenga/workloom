import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { WorkspaceReportBucketDto, WorkspaceReportResultDto } from '@workloom/contracts';
import { AccuracyTrend } from './AccuracyTrend';

const ratio = (value: number | null) => (value === null ? null : { numerator: String(Math.round(value * 100)), denominator: '100', decimal: String(value) });
const comparison = (value: number | null, paired: number) => ({ eligibleTasks: paired, pairedTasks: paired, plan: null, fact: null, difference: null, ratio: ratio(value), unavailableReason: null });
const bucket = (start: string, team: number, ann: number | null) => ({ startDate: start, endDate: start, comparison: comparison(team, 4), people: [{ membershipId: 'ann', displayName: 'Ann', comparison: comparison(ann, ann === null ? 0 : 3) }] }) as unknown as WorkspaceReportBucketDto;
const result = (annRatios: (number | null)[]) => ({
  bucket: 'week', summary: {}, people: [{ membershipId: 'ann', displayName: 'Ann' }],
  buckets: annRatios.map((value, index) => bucket(`2026-10-${String(5 + index * 7).padStart(2, '0')}`, 1.2, value)),
}) as unknown as WorkspaceReportResultDto;

describe('estimation accuracy table', () => {
  it('colours each week by distance from 100% and says the misses are shrinking', () => {
    render(<AccuracyTrend result={result([1.8, 1.4, 1.15, 1.02])} />);
    const row = screen.getByRole('row', { name: /Ann/ });
    expect(within(row).getAllByText(/%/).map(cell => cell.textContent)).toEqual(['180%', '140%', '115%', '102%']);
    expect(row.querySelectorAll('[data-accuracy-band="poor"]')).toHaveLength(2);
    expect(row.querySelector('[data-accuracy-band="fair"]')).not.toBeNull();
    expect(row.querySelector('[data-accuracy-band="good"]')).not.toBeNull();
    expect(row.querySelector('[data-accuracy-trend]')?.getAttribute('data-accuracy-trend')).toBe('improving');
    expect(within(row).getByText('Misses shrinking')).toBeInTheDocument();
  });
  it('shows a dash for a week without paired tasks and refuses a trend from too little data', () => {
    render(<AccuracyTrend result={result([1.5, null, 1.1])} />);
    const row = screen.getByRole('row', { name: /Ann/ });
    expect(within(row).getByText('—')).toBeInTheDocument();
    expect(row.querySelector('[data-accuracy-trend]')?.getAttribute('data-accuracy-trend')).toBe('notEnough');
  });
  it('renders nothing for a single period', () => {
    const { container } = render(<AccuracyTrend result={result([1.2])} />);
    expect(container).toBeEmptyDOMElement();
  });
});
