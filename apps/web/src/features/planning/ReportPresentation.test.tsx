import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CopyReportSummary } from './CopyReportSummary';
import { ReportSnapshotHeader } from './ReportSnapshotHeader';
import { WeeklyPeopleComparison } from './WeeklyPeopleComparison';
import { savedPeopleScope } from './reportSummary';
import { AS_OF, CREATED_AT, NICOSIA, avery, blair, casey, devon, ellis, fiveReport, nicosiaPeriod } from './test/reportPeople';

const BRIEF = 'Saved weekly plan vs actual report\nAll recorded hours: 3h 45m';
const inZone = (timestamp: string) => new Intl.DateTimeFormat('en', { dateStyle: 'short', timeStyle: 'short', timeZone: NICOSIA }).format(new Date(timestamp));
const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

/** Call after userEvent.setup(), which attaches its own clipboard stub. */
function installClipboard(writeText: ((text: string) => Promise<void>) | undefined) {
  const spy = writeText ? vi.fn(writeText) : undefined;
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: spy ? { writeText: spy } : undefined });
  return spy;
}

afterEach(() => {
  if (original) Object.defineProperty(navigator, 'clipboard', original);
  else Reflect.deleteProperty(navigator, 'clipboard');
});

describe('CopyReportSummary', () => {
  it('writes nothing on mount and copies the exact brief once on an explicit click', async () => {
    const user = userEvent.setup();
    const writeText = installClipboard(() => Promise.resolve());
    const brief = vi.fn(() => BRIEF);
    render(<CopyReportSummary brief={brief} />);
    expect(writeText).not.toHaveBeenCalled();
    expect(brief).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();

    const button = screen.getByRole('button', { name: 'Copy summary' });
    await user.click(button);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Summary copied to the clipboard.'));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(BRIEF);
    expect(button).toHaveFocus();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('announces a denied copy politely once and offers the exact text read-only, keeping focus on the button', async () => {
    const user = userEvent.setup();
    const writeText = installClipboard(() => Promise.reject(new DOMException('denied', 'NotAllowedError')));
    render(<CopyReportSummary brief={() => BRIEF} />);
    const button = screen.getByRole('button', { name: 'Copy summary' });
    await user.click(button);
    const status = screen.getByRole('status');
    await waitFor(() => expect(status).toHaveTextContent("Couldn't copy automatically. Select the text below and copy it manually."));
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(screen.getAllByText("Couldn't copy automatically. Select the text below and copy it manually.")).toHaveLength(1);
    const manual = screen.getByRole('textbox', { name: 'Report summary for manual copy' });
    expect(manual).toHaveValue(BRIEF);
    expect(manual).toHaveAttribute('readonly');
    expect(button).toHaveFocus();
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it('falls back to manual copy when no clipboard is available', async () => {
    const user = userEvent.setup();
    installClipboard(undefined);
    render(<CopyReportSummary brief={() => BRIEF} />);
    const button = screen.getByRole('button', { name: 'Copy summary' });
    await user.click(button);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent("Couldn't copy automatically."));
    expect(screen.getByRole('textbox', { name: 'Report summary for manual copy' })).toHaveValue(BRIEF);
    expect(button).toHaveFocus();
  });

  it('starts from idle again when remounted for another saved run', async () => {
    const user = userEvent.setup();
    installClipboard(() => Promise.reject(new Error('blocked')));
    const view = render(<CopyReportSummary key="run-1" brief={() => BRIEF} />);
    await user.click(screen.getByRole('button', { name: 'Copy summary' }));
    await screen.findByRole('textbox', { name: 'Report summary for manual copy' });
    view.rerender(<CopyReportSummary key="run-2" brief={() => 'another run'} />);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });
});

describe('ReportSnapshotHeader', () => {
  it('shows project, inclusive week, zone and saved times, with the five saved names collapsed', async () => {
    const user = userEvent.setup();
    render(<ReportSnapshotHeader projectName="Pilot" period={nicosiaPeriod()} createdAt={CREATED_AT} factCutoffAt={AS_OF} people={savedPeopleScope(fiveReport())} knownOnly={false} />);
    const header = screen.getByLabelText('Saved report identity');
    expect(within(header).getByText('Pilot')).toBeVisible();
    expect(within(header).getByText(/^Week 19 · May 3, 2026 – May 9, 2026$/)).toBeVisible();
    expect(header).not.toHaveTextContent('May 10');
    expect(within(header).getByText('Asia/Nicosia · every saved time here uses this zone')).toBeVisible();
    expect(within(header).getByText(inZone(CREATED_AT))).toBeVisible();
    expect(within(header).getByText(inZone(AS_OF))).toBeVisible();
    expect(within(header).getByText('5 people in saved report')).toBeVisible();
    expect(within(header).getByText('Known plans only: off')).toBeVisible();

    const names = within(header).getByText('Show saved names', { selector: 'summary' });
    expect(names.parentElement).not.toHaveAttribute('open');
    expect(within(header).getByText('Avery')).not.toBeVisible();
    await user.click(names);
    expect(names.parentElement).toHaveAttribute('open');
    expect(within(header).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Avery', 'Blair', 'Casey', 'Devon', 'Ellis']);
  });
});

describe('WeeklyPeopleComparison', () => {
  it('lists every saved person by name with known, zero, missing and no-baseline values from the DTO', () => {
    render(<WeeklyPeopleComparison people={fiveReport().byPerson} />);
    const table = screen.getByRole('table', { name: /Saved baseline, added and unplanned hours/ });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((row) => within(row).getByRole('rowheader').textContent)).toEqual(['Avery', 'Blair', 'Casey', 'Devon', 'Ellis']);
    const cells = (name: string) => {
      const row = rows.find((candidate) => within(candidate).getByRole('rowheader').textContent === name);
      if (!row) throw new Error(`Row missing for saved person "${name}"`);
      return within(row).getAllByRole('cell').map((cell) => cell.textContent);
    };
    expect(cells('Avery')).toEqual(['2h', '2h 30m', '+30m', 'Plans known 1 of 1 · actuals recorded 1 of 1', '0m', '0m', '2h 30m']);
    expect(cells('Blair')).toEqual(['1h', '0m', '−1h', 'Plans known 1 of 1 · actuals recorded 1 of 1', '0m', '0m', '0m']);
    expect(cells('Casey')).toEqual(['1h 30m', 'Not recorded', 'Insufficient data', 'Plans known 1 of 1 · actuals recorded 0 of 1', '0m', '0m', '0m']);
    expect(cells('Devon')).toEqual(['Not known', '45m', 'Insufficient data', 'Plans known 0 of 1 · actuals recorded 1 of 1', '0m', '0m', '45m']);
    expect(cells('Ellis')).toEqual(['No baseline work', 'No baseline work', 'Difference unavailable', 'No baseline work', '20m', '10m', '30m']);
  });

  it('keeps name order whatever the server order or variance', () => {
    render(<WeeklyPeopleComparison people={[ellis, avery, devon, blair, casey]} />);
    expect(screen.getAllByRole('rowheader').map((cell) => cell.textContent)).toEqual(['Avery', 'Blair', 'Casey', 'Devon', 'Ellis']);
  });

  it('says when the saved report has no people', () => {
    render(<WeeklyPeopleComparison people={[]} />);
    expect(screen.getByText('No people in the saved results.')).toBeVisible();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
