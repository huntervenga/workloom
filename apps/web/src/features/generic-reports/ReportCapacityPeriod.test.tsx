import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ReportCapacityPeriod } from './ReportCapacityPeriod';
import { reportCapacityView, type ReportCapacityChoice } from './reportCapacityView';
import { definition } from './test/fixtures';
async function choose(user: ReturnType<typeof userEvent.setup>, option: string) { await user.click(screen.getByRole('combobox', { name: 'Available hours period' })); await user.click(within(screen.getByRole('listbox', { name: 'Available hours period' })).getByRole('option', { name: option })); }
const dates = { from: '2026-10-19', to: '2026-10-25' };
describe('visible available-hours period', () => {
 it('keeps disclosure and custom date actions separate from a surrounding form submission',async()=>{const base=definition().config,submit=vi.fn(),change=vi.fn();render(<form onSubmit={event=>{event.preventDefault();submit();}}><ReportCapacityPeriod view={reportCapacityView(base,null,null)} baseConfig={base} disabled={false} onChange={change}/></form>);const user=userEvent.setup({pointerEventsCheck:0});await user.click(screen.getByLabelText('Available hours period · Task scope'));expect(submit).not.toHaveBeenCalled();await choose(user,'Custom range');await user.type(screen.getByLabelText('From (inclusive)'),'2026-10-19');await user.type(screen.getByLabelText('To (inclusive)'),'2026-10-25');await user.click(screen.getByRole('button',{name:'Apply period'}));expect(change).toHaveBeenCalledWith({kind:'custom',...dates});expect(submit).not.toHaveBeenCalled();await choose(user,'Custom range');await user.click(screen.getByRole('button',{name:'Cancel'}));expect(submit).not.toHaveBeenCalled();});
 it('shows inherited project dates separately from unchanged all-time task totals', async () => {
  const base = definition().config, change = vi.fn(); render(<ReportCapacityPeriod view={reportCapacityView(base, dates, null)} baseConfig={base} disabled={false} onChange={change}/>);
  const user=userEvent.setup({pointerEventsCheck:0});
  expect(screen.getByRole('combobox',{name:'Available hours period'})).toHaveTextContent('Project dates');
  const disclosure=screen.getByLabelText('Available hours period · Task scope');
  expect(disclosure.closest('details')).not.toHaveAttribute('open');
  expect(screen.getByText('Available: 2026-10-19 – 2026-10-25 · Project dates')).not.toBeVisible();
  await user.click(disclosure);expect(disclosure.closest('details')).toHaveAttribute('open');
  expect(screen.getByText('Available: 2026-10-19 – 2026-10-25 · Project dates')).toBeVisible();
  expect(screen.getByText('Task totals: all project tasks matching the current filters; no task-date filter.')).toBeVisible();
  await user.click(disclosure);expect(disclosure.closest('details')).not.toHaveAttribute('open');
  await choose(user,'None');expect(change).toHaveBeenCalledWith({kind:'none'});expect(base.capacity).toBeUndefined();expect(base.filters.dateRange).toBeNull();
 });
 it('validates and applies only the custom period, permits editing it again, and never silently assumes a week',async()=>{
  const base=definition().config,change=vi.fn();function Harness(){const[choice,setChoice]=useState<ReportCapacityChoice|null>(null);return <ReportCapacityPeriod view={reportCapacityView(base,null,choice)} baseConfig={base} disabled={false} onChange={next=>{change(next);setChoice(next);}}/>;}render(<Harness/>);
  const user=userEvent.setup({pointerEventsCheck:0});await user.click(screen.getByLabelText('Available hours period · Task scope'));expect(screen.getByText(/no week is assumed/)).toBeVisible();await choose(user,'Custom range');await user.click(screen.getByRole('button',{name:'Apply period'}));expect(screen.getByRole('alert')).toHaveFocus();expect(change).not.toHaveBeenCalled();
  await user.type(screen.getByLabelText('From (inclusive)'),'2026-10-19');await user.type(screen.getByLabelText('To (inclusive)'),'2026-10-25');await user.click(screen.getByRole('button',{name:'Apply period'}));expect(change).toHaveBeenCalledWith({kind:'custom',...dates});
  await user.click(screen.getByRole('button',{name:'Edit available period'}));expect(screen.getByLabelText('From (inclusive)')).toHaveValue(dates.from);await user.click(screen.getByRole('button',{name:'Cancel'}));expect(change).toHaveBeenCalledTimes(1);
 });
 it('keeps saved explicit dates as the default and has an explicit return to them',async()=>{const base={...definition().config,capacity:{startDate:'2026-09-01',endDate:'2026-09-30',people:{kind:'all_active' as const}}},change=vi.fn();function Harness(){const[choice,setChoice]=useState<ReportCapacityChoice|null>(null);return <ReportCapacityPeriod view={reportCapacityView(base,dates,choice)} baseConfig={base} disabled={false} onChange={next=>{change(next);setChoice(next);}}/>;}render(<Harness/>);const user=userEvent.setup({pointerEventsCheck:0});await user.click(screen.getByLabelText('Available hours period · Task scope'));expect(screen.getByText('Available: 2026-09-01 – 2026-09-30 · Report dates')).toBeVisible();await choose(user,'Project dates');await choose(user,'Report dates');expect(change).toHaveBeenLastCalledWith(null);});
});
