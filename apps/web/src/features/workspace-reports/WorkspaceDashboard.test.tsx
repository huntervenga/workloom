import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceDashboard } from './WorkspaceDashboard';
import { plan } from '../generic-reports/test/fixtures';
import { dashboardResult } from './test/fixtures';

describe('workspace manager dashboard', () => {
  it('keeps the full actual total but withholds team coverage when unassigned time has no capacity owner', () => {
    const data = dashboardResult(); const person = data.people[0]; if (!person) throw new Error('fixture');
    data.people.push({ ...person, membershipId: null, displayName: 'Unassigned', capacity: null });
    render(<WorkspaceDashboard result={data} onPersonSelect={() => undefined}/>);
    const actual = screen.getByRole('article', { name: 'Actual' });
    expect(actual).toHaveTextContent('15h'); expect(actual).toHaveTextContent('Recorded/available: —');
    expect(actual).toHaveAttribute('title', expect.stringContaining('no matching person'));
    expect(screen.getByRole('row', { name: new RegExp(person.displayName) })).toHaveTextContent('Recorded/available: ≈46.88%');
    expect(screen.queryByRole('button', { name: 'Unassigned' })).not.toBeInTheDocument();
  });

  it('combines authoritative capacity, standalone Plan and Actual and keeps paired accuracy separate', () => {
    render(<WorkspaceDashboard result={dashboardResult()} onPersonSelect={() => undefined}/>);
    expect(within(screen.getByRole('article', { name: 'Available capacity' })).getByText('40h')).toBeVisible();
    expect(within(screen.getByRole('article', { name: 'Plan' })).getByText('10h')).toBeVisible();
    const actual = screen.getByRole('article', { name: 'Actual' });
    expect(within(actual).getByText('15h')).toBeVisible();
    expect(actual).toHaveTextContent('Actual/estimate 200% on 1 of 2 tasks');
    expect(actual).toHaveTextContent('Recorded/available: 37.5%');
    expect(screen.queryByText('166h 39m')).not.toBeInTheDocument();
    const person = dashboardResult().people[0]; if (!person) throw new Error('fixture');
    const personRow = screen.getByRole('row', { name: new RegExp(person.displayName) });
    expect(personRow).toHaveTextContent('32h'); expect(personRow).toHaveTextContent('10h'); expect(personRow).toHaveTextContent('15h');
    expect(personRow).toHaveTextContent('Recorded/available: ≈46.88%');
    expect(screen.getByRole('region', { name: 'Weekly trend' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'Actual by category' })).toHaveTextContent('100%');
  });
  it('keeps unknown capacity and actual distinct from a genuine zero', () => {
    const data = dashboardResult(); data.capacity.totals.unconfiguredMembers = data.capacity.members.length; data.capacity.members = data.capacity.members.map(member => ({ ...member, scheduleKnown: false, availableMinutes: null }));
    data.summary.fact.value = null;
    const ui = render(<WorkspaceDashboard result={data} onPersonSelect={() => undefined}/>);
    expect(screen.getByRole('article', { name: 'Available capacity' })).toHaveTextContent('—');
    expect(screen.getByRole('article', { name: 'Actual' })).toHaveTextContent('Recorded/available: —');
    data.capacity.totals.unconfiguredMembers = 0; data.capacity.members = []; data.capacity.totals.availableMinutes = 0;
    data.summary.fact.value = { numerator: '0', denominator: '1', decimal: '0' };
    ui.rerender(<WorkspaceDashboard result={data} onPersonSelect={() => undefined}/>);
    expect(within(screen.getByRole('article', { name: 'Available capacity' })).getByText('0m')).toBeVisible();
    expect(within(screen.getByRole('article', { name: 'Actual' })).getByText('0m')).toBeVisible();
    expect(screen.getByRole('article', { name: 'Actual' })).toHaveTextContent('Recorded/available: —');
  });
  it('preserves exact values beyond Number precision and uses the full actual denominator for categories', () => {
    const data = dashboardResult();
    data.summary.fact.value = { numerator: '180143985094819860', denominator: '1', decimal: '180143985094819860' };
    const category = data.categories[0]; if (!category) throw new Error('fixture');
    category.fact.value = { numerator: '90071992547409930', denominator: '1', decimal: '90071992547409930' };
    render(<WorkspaceDashboard result={data} onPersonSelect={() => undefined}/>);
    expect(screen.getByRole('region', { name: 'Actual by category' })).toHaveTextContent('50%');
    expect(screen.getByRole('region', { name: 'Actual by category' }).querySelector('[style="width: 50%;"]')).not.toBeNull();
  });
  it('drills down a person using membership identity and exposes an action for missing work-type mappings', () => {
    const data = dashboardResult(), choose = vi.fn(), configure = vi.fn(); data.sources = data.sources.map(source => ({ ...source, categoryFieldId: null }));
    render(<WorkspaceDashboard result={data} onPersonSelect={choose} onConfigureTypes={configure}/>);
    const person = data.people[0]; if (!person) throw new Error('fixture');
    fireEvent.click(screen.getByRole('button', { name: person.displayName })); expect(choose).toHaveBeenCalledWith(person.membershipId);
    fireEvent.click(screen.getByRole('button', { name: 'Choose work types' })); expect(configure).toHaveBeenCalledTimes(1);
  });
});

it('shows a labelled known subtotal and keeps an individually known schedule visible beside unknown peers',()=>{
 const data=dashboardResult(),other=data.people[1];if(!other||!other.capacity)throw Error('fixture');
 other.capacity={...other.capacity,scheduleKnown:false,availableMinutes:null};data.capacity.members[1]=other.capacity;data.capacity.totals.unconfiguredMembers=1;data.capacity.totals.availableMinutes=1920;
 render(<WorkspaceDashboard result={data} onPersonSelect={()=>undefined}/>);
 const card=screen.getByRole('article',{name:'Available capacity'});expect(card).toHaveTextContent('32h');expect(card).toHaveTextContent('Known schedules only · 1 of 2 people');
 expect(screen.getByRole('article',{name:'Actual'})).toHaveTextContent('Recorded/available: —');
 const person=data.people[0];if(!person)throw Error('fixture');expect(screen.getByRole('row',{name:new RegExp(person.displayName)})).toHaveTextContent('32h');
});

it('resolves category colors from authorized project/field/option identity rather than displayed names',()=>{
 const data=dashboardResult(),category=data.categories[0];if(!category?.projectId||!category.fieldId||!category.optionId)throw Error('fixture');
 const field={...plan,type:'single_select' as const,id:category.fieldId,projectId:category.projectId,name:'Types',options:[{id:category.optionId,name:'Renamed label',color:'#ffffff',position:7,revision:2,archivedAt:null}]};
 const {container}=render(<WorkspaceDashboard result={data} categoryFields={[field]} onPersonSelect={()=>undefined}/>);
 expect(container.querySelector('[data-category-swatch]')).toHaveStyle({backgroundColor:'#ffffff'});expect(container.querySelector('[data-category-bar]')).toHaveStyle({backgroundColor:'#ffffff',width:'100%'});
});
