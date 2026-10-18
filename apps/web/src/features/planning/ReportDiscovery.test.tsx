import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { t } from '../../i18n';
import { ReportSetupDisclosure } from './ReportSetupDisclosure';
const props = () => ({ title: 'Report', selector: <button type="button">Calculate team report</button>, hasSavedReport: false, quickActionAvailable: true, setup: undefined, held: false, failed: false, onExpandedChange: vi.fn(), children: <input aria-label="Advanced scope" /> });
describe('discoverable report with a safe explicit default', () => {
  it('renders completed review amounts and ratio without placeholder braces', () => {
    const ratio = t('weeklyReports.ratio', { percent: '150' });
    expect(ratio).toBe('150% of original personal plan');
    expect(t('weeklyReports.completed', { difference: '+30m', ratio })).toBe('Completed · +30m · 150% of original personal plan');
  });
  it('shows the calculation action before advanced setup without writing anything', async () => {
    const p = props(); const user = userEvent.setup(); render(<ReportSetupDisclosure {...p} />);
    expect(screen.getByRole('button', { name: 'Calculate team report' })).toBeVisible();
    expect(screen.queryByRole('textbox', { name: 'Advanced scope' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Set up new report' }));
    expect(p.onExpandedChange).toHaveBeenCalledExactlyOnceWith(true);
  });
  it.each([{ held: true }, { failed: true }, { setup: { expanded: false, dirty: true, configurationKey: null } }])('keeps unresolved, failed or dirty settings visible (%j)', extra => {
    render(<ReportSetupDisclosure {...props()} {...extra} />);
    expect(screen.getByRole('textbox', { name: 'Advanced scope' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Hide report setup' })).toBeDisabled();
  });
  it('keeps first-use setup visible when no safe default action exists', () => {
    render(<ReportSetupDisclosure {...props()} quickActionAvailable={false} />);
    expect(screen.getByRole('textbox', { name: 'Advanced scope' })).toBeVisible();
  });
});
