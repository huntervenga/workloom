import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ReportQuickFilters } from './ReportQuickFilters';
import { definition, plan, fact } from './test/fixtures';
import { alphaMembers } from '../../test/fakeApi';
async function choose(user:ReturnType<typeof userEvent.setup>,label:string,option:string){await user.click(screen.getByRole('combobox',{name:label}));await user.click(within(screen.getByRole('listbox',{name:label})).getByRole('option',{name:option}));}
describe('temporary report filters',()=>{
 it('keeps arbitrary source field IDs and measures while applying an inclusive due-date range and person',async()=>{
  const original=definition().config,apply=vi.fn(),user=userEvent.setup({pointerEventsCheck:0});
  render(<ReportQuickFilters config={original} originalConfig={original} fields={[plan,fact]} members={alphaMembers} disabled={false} onApply={apply} onReset={vi.fn()}/>);
  await choose(user,'People','Unassigned');await choose(user,'Date source','Due date');
  await user.type(screen.getByLabelText('From (inclusive)'),'2026-10-12');await user.type(screen.getByLabelText('To (inclusive)'),'2026-10-18');
  await user.click(screen.getByRole('button',{name:'Apply filters'}));
  expect(apply).toHaveBeenCalledWith({...original,filters:{...original.filters,assignee:{kind:'unassigned'},dateRange:{source:{kind:'due_date'},from:'2026-10-12',to:'2026-10-18'}}});
  expect(original.filters.dateRange).toBeNull();
 });
 it('rejects reversed ranges without changing the read scope and resets controls to the saved scope',async()=>{
  const original=definition().config,changed={...original,filters:{...original.filters,assignee:{kind:'unassigned' as const}}},apply=vi.fn(),reset=vi.fn(),user=userEvent.setup({pointerEventsCheck:0});
  render(<ReportQuickFilters config={changed} originalConfig={original} fields={[]} members={alphaMembers} disabled={false} onApply={apply} onReset={reset}/>);
  await choose(user,'Date source','Due date');await user.type(screen.getByLabelText('From (inclusive)'),'2026-10-18');await user.type(screen.getByLabelText('To (inclusive)'),'2026-10-12');await user.click(screen.getByRole('button',{name:'Apply filters'}));
  expect(apply).not.toHaveBeenCalled();expect(screen.getByRole('alert')).toBeVisible();
  await user.click(screen.getByRole('button',{name:'Saved scope'}));expect(reset).toHaveBeenCalledOnce();expect(screen.getByRole('combobox',{name:'People'})).toHaveTextContent('Everyone');expect(screen.getByRole('combobox',{name:'Date source'})).toHaveTextContent('All time');
 });
 it('aligns optional capacity boundaries and people only after the explicit checkbox choice',async()=>{const source=definition().config,original={...source,capacity:{startDate:'2026-10-01',endDate:'2026-10-31',people:{kind:'all_active' as const}}},apply=vi.fn(),user=userEvent.setup({pointerEventsCheck:0});render(<ReportQuickFilters config={original} originalConfig={original} fields={[plan,fact]} members={alphaMembers} disabled={false} onApply={apply} onReset={vi.fn()}/>);await choose(user,'Date source','Due date');await user.type(screen.getByLabelText('From (inclusive)'),'2026-10-12');await user.type(screen.getByLabelText('To (inclusive)'),'2026-10-18');await user.click(screen.getByRole('checkbox',{name:'Use these dates and people for capacity too'}));await user.click(screen.getByRole('button',{name:'Apply filters'}));expect(apply).toHaveBeenCalledWith(expect.objectContaining({capacity:{startDate:'2026-10-12',endDate:'2026-10-18',people:{kind:'all_active'}}}));expect(original.capacity.endDate).toBe('2026-10-31');});

});
