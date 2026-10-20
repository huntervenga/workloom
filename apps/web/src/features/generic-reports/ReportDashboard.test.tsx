import type { GenericComparisonDto, GenericGroupResultDto, GenericMeasureResultDto, GenericReportNumberDto, GenericReportResultDto } from '@workloom/contracts';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { ReportDashboard, recordedCapacityRatio } from './ReportDashboard';
import { amount, coverage, fact, plan, result } from './test/fixtures';
import { field } from '../fields/test/fixtures';
import { alphaMembers } from '../../test/fakeApi';

const optionId = '91000000-0000-4000-8000-000000000003';
const category = { ...field('Work type', 'single_select', '90000000-0000-4000-8000-000000000003'), options: [{ id: optionId, name: 'Discovery', color: null, position: 0, revision: 1, archivedAt: null }] };
const giant = (numerator: string): GenericReportNumberDto => ({ numerator, denominator: '1', decimal: numerator });
const sum = (key: string, fieldId: string, value: GenericReportNumberDto | null, filled = 1): GenericMeasureResultDto => ({ key, operation: 'sum', fieldId, unit: 'minutes', value, coverage: { tasks: 1, filled, missing: 1 - filled, null: 0, zero: value?.numerator === '0' ? 1 : 0 } });
const group = (key: string, measures: GenericMeasureResultDto[], comparison: GenericComparisonDto | null = null): GenericGroupResultDto => ({ key, label: key, taskCount: 1, measures, comparison, initialComparison: null });
function pair(planValue: GenericReportNumberDto | null, factValue: GenericReportNumberDto | null, difference: GenericReportNumberDto | null, pairedTasks: number, eligibleTasks: number, unavailableReason: GenericComparisonDto['unavailableReason'] = null): GenericComparisonDto {
  const base = result().comparison;
  if (!base) throw new Error('Missing comparison fixture');
  return { ...base, plan: planValue, fact: factValue, difference, ratio: null, pairedTasks, eligibleTasks, unavailableReason };
}
function byAssignee(groups: GenericGroupResultDto[]): GenericReportResultDto {
  const source = result();
  return { ...source, config: { ...source.config, groupBy: { kind: 'assignee' } }, groups };
}
function byCategory(measures: GenericMeasureResultDto[], groups: GenericGroupResultDto[]): GenericReportResultDto {
  const source = result();
  return { ...source, fields: [plan, fact, category], config: { ...source.config, groupBy: { kind: 'category', fieldId: category.id } }, measures, groups };
}
function capacity(settingsConfigured: boolean): NonNullable<GenericReportResultDto['capacity']> {
  return { startDate: '2026-10-01', endDate: '2026-10-31', settingsConfigured, sourceVersion: 'c'.repeat(64), days: [], members: [], totals: { scheduledMinutes: 2400, holidayMinutes: 480, absenceMinutes: 1920, availableMinutes: 0, unconfiguredMembers: 2 }, intervals: [], companyHolidays: [], inputVersions: { settingsRevision: 1, profiles: [], requests: [] } };
}
function firstMember() {
  const member = alphaMembers[0];
  if (!member) throw new Error('Missing member fixture');
  return member;
}
function view(source: GenericReportResultDto, extra: { onPersonSelect?: (membershipId: string | null) => void; onChoosePeriod?: () => void } = {}) {
  return <MemoryRouter><ReportDashboard result={source} members={alphaMembers} sections={[]} {...extra}/></MemoryRouter>;
}

describe('top cards', () => {
  it('keeps full-scope totals separate from the labelled paired subset and leaves a missing fact sum unknown', () => {
    render(view(result()));
    const planCard = screen.getByRole('article', { name: 'Plan · Budget' });
    expect(planCard).toHaveTextContent('18h 51m');
    expect(planCard).toHaveTextContent('60/63 filled · 2 missing · 1 cleared · 1 zero');
    expect(planCard).toHaveTextContent('Paired subset: 14h 30m · 7 of 8 eligible tasks');
    const factCard = screen.getByRole('article', { name: 'Actual · Spent' });
    expect(within(factCard).getByText('—')).toBeVisible();
    expect(factCard).toHaveTextContent('No full-scope Sum measure for this field.');
    expect(factCard).toHaveTextContent('Paired subset: 17h · 7 of 8 eligible tasks');
    expect(screen.getByRole('article', { name: 'Available capacity' })).toHaveTextContent('Choose a date range');
  });

  it('shows number fields as exact numbers instead of hours', () => {
    const source = result(), cost = field('Cost', 'number', '90000000-0000-4000-8000-000000000004');
    render(view({ ...source, fields: [plan, cost], config: { ...source.config, comparison: { planFieldId: plan.id, factFieldId: cost.id, completion: 'all_tasks' } }, measures: [...source.measures, { key: 'cost', operation: 'sum', fieldId: cost.id, unit: 'number', value: { numerator: '2501', denominator: '2', decimal: '1250.5' }, coverage }] }));
    const card = screen.getByRole('article', { name: 'Actual · Cost' });
    expect(within(card).getByText('1250.5')).toBeVisible();
    expect(card).toHaveTextContent('Paired subset: 1020 · 7 of 8 eligible tasks');
    expect(card).not.toHaveTextContent('17h');
    expect(card).not.toHaveTextContent('minutes');
  });

  it('shows capacity beside recorded time without a utilization percentage and keeps zero distinct from unknown', () => {
    const source = result();
    const ui = render(view({ ...source, capacity: capacity(true) }));
    const card = screen.getByRole('article', { name: 'Available capacity' });
    expect(within(card).getByText('—')).toBeVisible();
    expect(card).toHaveTextContent('2026-10-01 through 2026-10-31 (inclusive)');
    expect(card).toHaveTextContent('Scheduled 40h · holidays 8h · time off 32h');
    expect(card).toHaveTextContent('Schedule unknown for 2 members');
    expect(card).toHaveTextContent('Recorded / available: —'); expect(card).toHaveTextContent('not attendance or productivity');
    expect(screen.getByRole('region', { name: 'Report overview' })).not.toHaveTextContent('%');
    ui.rerender(view({ ...source, capacity: capacity(false) }));
    const unknown = screen.getByRole('article', { name: 'Available capacity' });
    expect(within(unknown).getByText('—')).toBeVisible();
    expect(within(unknown).getByRole('status')).toHaveTextContent('Time off settings are not configured');
    expect(within(unknown).queryByText('0m')).not.toBeInTheDocument();
  });
});

describe('plan and actual by primary assignee', () => {
  it('describes paired subsets with explicit deltas and drills down by membership id only when requested', () => {
    const person = firstMember(), former = '99999999-9999-4999-8999-999999999999';
    const people = byAssignee([group(person.id, [sum('budget',plan.id,amount(900)),sum('spent',fact.id,amount(400))], pair(amount(600), amount(200), amount(-400), 2, 3)), group('unassigned', [], pair(amount(60), amount(90), amount(30), 1, 2)), group(former, [], pair(amount(30), null, null, 0, 1, 'missing_fact'))]);
    const selected: (string | null)[] = [];
    const ui = render(view(people, { onPersonSelect: id => { selected.push(id); } }));
    expect(screen.getByRole('row', { name: `${person.displayName} · Available: — · Plan: 15h · Actual: 6h 40m` })).toBeVisible();
    expect(screen.getByRole('row', { name: 'Unassigned · Available: — · Plan: — · Actual: —' })).toBeVisible();
    expect(screen.getByRole('row', { name: 'Former member · Available: — · Plan: — · Actual: —' })).toBeVisible();
    expect(screen.getByText('Paired coverage: 7 of 8 eligible tasks in the full scope.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: `Show tasks for ${person.displayName}` }));
    fireEvent.click(screen.getByRole('button', { name: 'Show tasks for Unassigned' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show tasks for Former member' }));
    expect(selected).toEqual([person.id, null, former]);
    ui.rerender(view(people));
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    ui.rerender(view({ ...people, config: { ...people.config, groupBy: { kind: 'status' } } }));
    expect(screen.queryByRole('region', { name: 'Plan and actual by primary assignee' })).not.toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('scales bars and shares with exact rationals beyond Number precision', () => {
    const person = firstMember();
    const ui = render(view(byAssignee([group(person.id, [sum('budget',plan.id,giant('9007199254740993001')),sum('spent',fact.id,giant('27021597764222979003'))], pair(giant('9007199254740993001'), giant('27021597764222979003'), giant('18014398509481986002'), 1, 1))])));
    const bars = screen.getByRole('row', { name: `${person.displayName} · Available: — · Plan: 150119987579016550h 1m · Actual: 450359962737049650h 3m` });
    expect(bars.querySelector('[data-series="plan"]')).toHaveStyle({ width: '33.33%' });
    expect(bars.querySelector('[data-series="fact"]')).toHaveStyle({ width: '100%' });
    // Float division rounds both operands to the same double ratio and would claim exactly 50%.
    ui.rerender(view(byCategory([sum('budget', plan.id, giant('18014398509481986001'))], [group(optionId, [sum('budget', plan.id, giant('9007199254740993001'))])])));
    expect(screen.getByRole('img', { name: 'Discovery: 150119987579016550h 1m of 300239975158033100h 1m recorded · ≈50% of the full-scope total.' })).toBeVisible();
  });
});

describe('category distribution', () => {
  it('divides by the full-scope fact sum, includes Uncategorized and states overlapping tag filters', () => {
    const source = byCategory([sum('budget', plan.id, amount(1000)), sum('spent', fact.id, amount(200))], [group(optionId, [sum('budget', plan.id, amount(900)), sum('spent', fact.id, amount(150))]), group('uncategorized', [sum('budget', plan.id, amount(100)), sum('spent', fact.id, amount(50))])]);
    render(view({ ...source, config: { ...source.config, filters: { ...source.config.filters, tagIds: ['a0000000-0000-4000-8000-000000000001'] } } }));
    const region = screen.getByRole('region', { name: 'Distribution by Work type' });
    expect(screen.getByRole('img', { name: 'Discovery: 2h 30m of 3h 20m recorded · 75% of the full-scope total.' })).toBeVisible();
    expect(screen.getByRole('img', { name: 'Uncategorized: 50m of 3h 20m recorded · 25% of the full-scope total.' })).toBeVisible();
    expect(region).toHaveTextContent('Spent · full-scope total 3h 20m');
    expect(region).not.toHaveTextContent('90%');
    expect(region).toHaveTextContent('Tags can overlap');
    expect(source.rows).toHaveLength(1); // One tiny loaded row; the denominator stays the server's complete scope.
  });

  it('falls back to the first duration sum and keeps recorded zero distinct from unknown', () => {
    const source = result();
    const average: GenericMeasureResultDto = { ...sum('average', plan.id, amount(5)), operation: 'avg' };
    const categorized = byCategory([average, sum('budget', plan.id, amount(100))], [group(optionId, [sum('budget', plan.id, amount(0))]), group('uncategorized', [sum('budget', plan.id, null, 0)])]);
    const base: GenericReportResultDto = { ...categorized, comparison: null, config: { ...categorized.config, comparison: null } };
    const ui = render(view(base));
    expect(screen.queryAllByRole('article')).toHaveLength(0);
    expect(screen.getByRole('img', { name: 'Discovery: 0m of 1h 40m recorded · 0% of the full-scope total.' })).toBeVisible();
    expect(screen.getByRole('img', { name: 'Uncategorized: — recorded · share unavailable.' })).toBeVisible();
    expect(screen.queryByText(/≈/)).not.toBeInTheDocument();
    ui.rerender(view({ ...base, measures: [average] }));
    expect(screen.getByRole('status')).toHaveTextContent('Add a duration Sum measure');
    expect(source.config.groupBy).not.toEqual(base.config.groupBy);
  });
});

describe('honest recorded-time capacity ratios',()=>{
 function aligned():GenericReportResultDto{const source=result(),person=firstMember(),cal=capacity(true);return {...source,measures:[...source.measures,sum('actual',fact.id,amount(180))],config:{...source.config,filters:{...source.config.filters,assignee:{kind:'member',membershipId:person.id},dateRange:{source:{kind:'due_date'},from:cal.startDate,to:cal.endDate}}},capacity:{...cal,totals:{...cal.totals,availableMinutes:120,unconfiguredMembers:0},members:[{membershipId:person.id,displayName:person.displayName,scheduleKnown:true,scheduledMinutes:120,holidayMinutes:0,absenceMinutes:0,availableMinutes:120}]}};}
 it('uses the authoritative full-scope actual sum, permits over 100%, and never the paired actual subtotal',()=>{const source=aligned();expect(recordedCapacityRatio(source)).toBe('150');render(view(source));expect(screen.getByText('Recorded / available: 150%')).toBeVisible();expect(source.comparison?.fact).toEqual(amount(1020));});
 it('keeps zero, unknown schedules, missing full sums and mismatched people or date boundaries unavailable',()=>{const source=aligned();if(!source.capacity)throw new Error('Missing capacity');expect(recordedCapacityRatio({...source,capacity:{...source.capacity,totals:{...source.capacity.totals,availableMinutes:0}}})).toBeNull();expect(recordedCapacityRatio({...source,capacity:{...source.capacity,totals:{...source.capacity.totals,unconfiguredMembers:1}}})).toBeNull();expect(recordedCapacityRatio({...source,measures:[]})).toBeNull();expect(recordedCapacityRatio({...source,config:{...source.config,filters:{...source.config.filters,dateRange:null}}})).toBeNull();expect(recordedCapacityRatio({...source,config:{...source.config,filters:{...source.config.filters,assignee:{kind:'unassigned'}}}})).toBeNull();});
 it('shows authoritative paired Actual / Estimate at a glance and keeps a missing ratio unknown',()=>{const person=firstMember(),comparison=pair(amount(100),amount(125),amount(25),1,1);comparison.ratio={numerator:'5',denominator:'4',decimal:'1.25'};const source=byAssignee([group(person.id,[],comparison)]);const ui=render(view(source));expect(screen.getByText('Actual / estimate: 125%')).toBeVisible();ui.rerender(view({...source,groups:[group(person.id,[],{...comparison,plan:amount(0),ratio:null,unavailableReason:'zero_plan'})]}));expect(screen.getByText('Actual / estimate: —')).toHaveAttribute('title','The paired plan is zero. A ratio is not available.');});
});


describe('capacity context alongside person totals',()=>{
 it('retains an authorized person without tasks or a configured schedule, using the provided name rather than omitting the row',()=>{
  const id='99999999-9999-4999-8999-999999999999',base=byAssignee([]),cal=capacity(false);
  render(view({...base,capacity:{...cal,members:[{membershipId:id,displayName:'Authorized colleague',scheduleKnown:false,scheduledMinutes:null,holidayMinutes:null,absenceMinutes:null,availableMinutes:null}]}}));
  expect(screen.getByRole('row',{name:'Authorized colleague · Available: — · Plan: — · Actual: —'})).toHaveTextContent('0 tasks');
 });
 it('explains mismatched date scopes and offers an explicit alignment action without inventing comparable capacity',()=>{
  const base=byAssignee([]),cal=capacity(true),align=vi.fn();
  render(view({...base,config:{...base.config,filters:{...base.config.filters,dateRange:{source:{kind:'due_date'},from:'2026-10-12',to:'2026-10-18'}}},capacity:cal},{onChoosePeriod:align}));
  expect(screen.getByText('Available hours cover 2026-10-01 through 2026-10-31; task totals use a different date scope.')).toBeVisible();
  fireEvent.click(screen.getByRole('button',{name:'Use selected dates'}));expect(align).toHaveBeenCalledOnce();
  expect(base.config.filters.dateRange).toBeNull();
 });
});

it('shows the authoritative known subtotal without hiding a configured person because a peer is unknown',()=>{
 const source=byAssignee([]),person=firstMember(),cal=capacity(true);
 cal.members=[{membershipId:person.id,displayName:person.displayName,scheduleKnown:true,scheduledMinutes:2400,holidayMinutes:0,absenceMinutes:480,availableMinutes:1920},{membershipId:'99999999-9999-4999-8999-999999999999',displayName:'Unknown peer',scheduleKnown:false,scheduledMinutes:null,holidayMinutes:null,absenceMinutes:null,availableMinutes:null}];cal.totals={scheduledMinutes:2400,holidayMinutes:0,absenceMinutes:480,availableMinutes:1920,unconfiguredMembers:1};
 render(view({...source,capacity:cal}));const card=screen.getByRole('article',{name:'Available capacity'});expect(card).toHaveTextContent('32h');expect(card).toHaveTextContent('Known schedules only · 1 of 2 people');expect(card).toHaveTextContent('Recorded / available: —');
 expect(screen.getByRole('row',{name:new RegExp(`${person.displayName} · Available: 32h`)})).toBeVisible();
});
it('uses stored category color for its swatch and exact-share bar, preserving readable theme text',()=>{
 const source=byCategory([sum('actual',fact.id,amount(60))],[group(optionId,[sum('actual',fact.id,amount(60))])]);source.fields=source.fields.map(f=>f.id===category.id?{...f,options:category.options.map(o=>({...o,color:'#db2777'}))}:f);
 const {container}=render(view(source));const item=container.querySelector(`[data-report-category-option="${optionId}"]`);expect(item?.querySelector('[data-category-swatch]')).toHaveStyle({backgroundColor:'#db2777'});expect(item?.querySelector('[data-category-bar]')).toHaveStyle({backgroundColor:'#db2777',width:'100%'});
});
