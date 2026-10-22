import type { LeaveRequestDto } from '@workloom/contracts';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { ScheduleBar } from '../schedule/GanttView';
import { calendarWindow } from '../schedule/dates';
import { availabilitySummary, GanttAvailabilityBands, supportedAvailabilityWindow, unavailableDates } from './GanttAvailability';
import { ReportCapacityResults } from './ReportCapacityResults';
import { approvedCalendarAllocations, TimeOffCalendar } from './TimeOffCalendar';
import { availability, MEMBER, OTHER, overview, required } from './test/fixtures';
describe('neutral time off availability', () => {
  it('clips only leave coverage while preserving the wider task calendar', () => {
    expect(supportedAvailabilityWindow(required(calendarWindow('0001-01-01', 28)))).toBeNull();
    expect(supportedAvailabilityWindow(required(calendarWindow('9999-12-31', 28)))).toBeNull();
    expect(supportedAvailabilityWindow(required(calendarWindow('1899-12-25', 28)))).toEqual({ startDate: '1900-01-01', endDate: '1900-01-21', complete: false });
    expect(supportedAvailabilityWindow(required(calendarWindow('2200-12-25', 28)))).toEqual({ startDate: '2200-12-25', endDate: '2200-12-31', complete: false });
    expect(supportedAvailabilityWindow(required(calendarWindow('2026-10-19', 28)))).toEqual({ startDate: '2026-10-19', endDate: '2026-11-15', complete: true });
  });
  it('shades own absences and company holidays without leaking another assignee’s interval', () => {
    const window = required(calendarWindow('2026-10-19', 28)); const source = availability();
    source.days.push(...[MEMBER, OTHER].map(membershipId => ({membershipId,date:'2026-10-23',scheduledMinutes:480,holidayMinutes:480,absenceMinutes:0,availableMinutes:0})));
    expect([...unavailableDates(source, MEMBER, window)].sort()).toEqual(['2026-10-20', '2026-10-23']);
    expect([...unavailableDates(source, OTHER, window)]).toEqual(['2026-10-23']);
    expect([...unavailableDates(source, null, window)]).toEqual([]);
  });
  it('never intercepts pointers intended for a Gantt bar', () => {
    const { container } = render(<GanttAvailabilityBands dates={new Set(['2026-10-20'])} window={required(calendarWindow('2026-10-19',28))} width={36}/>);
    const band = container.querySelector('[data-gantt-availability]'); expect(band).toHaveClass('pointer-events-none'); expect(band?.firstElementChild).toHaveClass('pointer-events-none'); expect(band?.firstElementChild).toHaveStyle({ left: '36px', width: '36px' });
  });
  it('distinguishes 40→32h after a day off, zero-task people and unknown schedules', () => {
    const capacity = availability(); capacity.members.push({ membershipId: 'e0000000-0000-4000-8000-000000000099', displayName: 'Unknown schedule', scheduleKnown: false, scheduledMinutes: null, holidayMinutes: null, absenceMinutes: null, availableMinutes: null }); capacity.totals.unconfiguredMembers = 1;
    render(<ReportCapacityResults capacity={capacity} comparison={{ planName: 'Plan', factName: 'Fact', values: new Map([[MEMBER, { plan: '36h', fact: '30h' }]]) }}/>);
    const row = screen.getByRole('row', { name: 'Worked on tasks 40h 0h 8h 32h 36h 30h' }); expect(row).toBeVisible();
    expect(screen.getByRole('row', { name: 'No tasks this week 40h 0h 0h 40h — —' })).toBeVisible();
    expect(screen.getByRole('row', { name: /Unknown schedule.*— — — — — —/ })).toBeVisible(); expect(screen.getByRole('status')).toHaveTextContent('1 people have no configured schedule');
    expect(screen.queryByText(/daily actual hours worked/i)).not.toBeInTheDocument();
  });
  it('calendar contains neutral approved intervals and keeps people separated', () => {
    render(<TimeOffCalendar availability={availability()} members={overview().members}/>);
    const first = screen.getByRole('row', { name: new RegExp(required(overview().members[0]).displayName) });
    expect(within(first).getByRole('img', { name: '2026-10-20: Unavailable' })).toBeVisible();
    const second = screen.getByRole('row', { name: new RegExp(required(overview().members[1]).displayName) });
    expect(within(second).queryByRole('img', { name: '2026-10-20: Unavailable' })).not.toBeInTheDocument();
  });
  it('tints whole weekend columns while marking only real scheduled absences, including weekend workers', () => {
    const source = availability(); source.startDate = '2026-10-23'; source.endDate = '2026-10-26'; source.companyHolidays = []; source.intervals = [MEMBER,OTHER].map(membershipId => ({membershipId,startDate:source.startDate,endDate:source.endDate}));
    source.days = [MEMBER,OTHER].flatMap(membershipId => ['2026-10-23','2026-10-24','2026-10-25','2026-10-26'].map((date,index) => { const minutes = membershipId === MEMBER ? index === 0 || index === 3 ? 480 : 0 : index === 1 ? 240 : 0; return {membershipId,date,scheduledMinutes:minutes,holidayMinutes:0,absenceMinutes:minutes,availableMinutes:0}; }));
    const { container } = render(<TimeOffCalendar availability={source} members={overview().members}/>);
    for (const date of ['2026-10-24','2026-10-25']) for (const cell of container.querySelectorAll(`[data-calendar-date="${date}"]`)) expect(cell).toHaveClass('bg-[#e2e8f0]', '[[data-theme=dark]_&]:bg-[#334155]');
    const first = screen.getByRole('row', {name:new RegExp(required(overview().members[0]).displayName)});
    expect(within(first).getByRole('img',{name:'2026-10-24: Non-working day'})).not.toHaveClass('bg-accent');
    expect(within(first).queryByRole('img',{name:'2026-10-25: Unavailable'})).not.toBeInTheDocument();
    const second = screen.getByRole('row', {name:new RegExp(required(overview().members[1]).displayName)});
    expect(within(second).getByRole('img',{name:'2026-10-24: Unavailable'})).toHaveStyle({backgroundColor:'#e11d48'});
    expect(within(second).getByRole('img',{name:'2026-10-24: Unavailable'}).parentElement).toHaveAttribute('title',expect.stringContaining('4h scheduled'));
    expect([...unavailableDates(source,MEMBER,required(calendarWindow(source.startDate,28)))]).toEqual(['2026-10-23','2026-10-26']);
    expect(availabilitySummary(source,OTHER,source.startDate,source.endDate)).toEqual({dates:['2026-10-24'],minutes:240});
  });
  it('keeps approved recorded allocations visible without claiming that capacity was removed', () => {
    const source = availability(); source.days = [{membershipId:MEMBER,date:'2026-10-20',scheduledMinutes:480,holidayMinutes:0,absenceMinutes:0,availableMinutes:480},{membershipId:MEMBER,date:'2026-10-21',scheduledMinutes:480,holidayMinutes:0,absenceMinutes:0,availableMinutes:480}];
    const allocations = [{membershipId:MEMBER,date:'2026-10-20',microdays:1_000_000,scheduledMinutes:480},{membershipId:MEMBER,date:'2026-10-21',microdays:0,scheduledMinutes:480}];
    render(<TimeOffCalendar availability={source} members={overview().members} allocations={allocations} colors={new Map([[`${MEMBER}:2026-10-20`,'#f59e0b']])}/>);
    expect(screen.getByRole('img',{name:'2026-10-20: Approved time off'})).toHaveStyle({backgroundColor:'#f59e0b'});
    expect(screen.getByRole('img',{name:'2026-10-20: Approved time off'})).not.toHaveClass('bg-accent');
    expect(screen.getByRole('img',{name:'2026-10-20: Approved time off'}).parentElement).toHaveAttribute('title',expect.stringContaining('1 recorded balance days'));
    expect(screen.getByRole('img',{name:'2026-10-21: Recorded absence'}).parentElement).toHaveAttribute('title',expect.stringContaining('8h available'));
    expect([...unavailableDates(source,MEMBER,required(calendarWindow(source.startDate,28)))]).toEqual([]);
    expect(approvedCalendarAllocations([])).toEqual([]);
  });
  it('passes only approved recorded date allocations into the calendar, without private request fields', () => {
    const request: LeaveRequestDto = { id:'f0000000-0000-4000-8000-000000000001',workspaceId:'a0000000-0000-4000-8000-000000000001',membershipId:MEMBER,typeId:'e0000000-0000-4000-8000-000000000001',startDate:'2026-10-20',endDate:'2026-10-25',note:'Private family detail',revision:1,status:'approved',createdBy:MEMBER,createdAt:'2026-10-19T12:00:00.000Z',updatedAt:'2026-10-19T12:00:00.000Z',consumesBalance:false,pausesAccrual:false,capacityUnavailable:false,chargedDays:[{date:'2026-10-20',microdays:0,scheduledMinutes:480}],negativeApproved:false };
    expect(approvedCalendarAllocations([request,{...request,status:'pending'}])).toEqual([{membershipId:MEMBER,date:'2026-10-20',microdays:0,scheduledMinutes:480}]);
    expect(JSON.stringify(approvedCalendarAllocations([request]))).not.toContain('Private family detail');
  });
  it('keeps missing schedules unknown instead of inventing availability from an interval', () => {
    const source = availability(); required(source.members[0]).scheduleKnown = false;
    expect(availabilitySummary(source,MEMBER,'2026-10-19','2026-10-25')).toBeNull();
    expect([...unavailableDates(source,MEMBER,required(calendarWindow(source.startDate,28)))]).toEqual([]);
  });
  it('explains availability on bar hover and keyboard focus without intercepting drag', async () => {
    const user = userEvent.setup(); const pointerDown = vi.fn(); const open = vi.fn(); const message = 'Anna · unavailable: 2026-10-20 · 8h in this view';
    render(<ScheduleBar start="2026-10-19" due="2026-10-21" window={required(calendarWindow('2026-10-19',28))} title="Delivery" onFocus={vi.fn()} onActivate={open} availabilityHint={message} handle={{onPointerDown:pointerDown,onClickCapture:vi.fn(),movable:MEMBER}}/>);
    const bar = screen.getByRole('button',{name:/Open Delivery/});
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument(); await user.hover(bar); expect(screen.getByRole('tooltip')).toHaveTextContent(message); expect(screen.getByRole('tooltip')).toHaveClass('pointer-events-none'); await user.unhover(bar); expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    await user.tab(); expect(bar).toHaveFocus(); expect(bar).toHaveAccessibleDescription(message); expect(screen.getByRole('tooltip')).toBeVisible(); fireEvent.pointerDown(bar,{button:0,pointerId:1}); expect(pointerDown).toHaveBeenCalledOnce(); expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    await user.keyboard('{Enter}'); expect(open).toHaveBeenCalledOnce();
  });
  it('keeps a near-end hint visible after horizontal scrolling and repositions only while open', async () => {
    const user = userEvent.setup();
    const { container } = render(<div data-gantt-scroll=""><ScheduleBar start="2026-12-15" due="2026-12-16" window={required(calendarWindow('2026-01-01',366))} title="Near end" onFocus={vi.fn()} onActivate={vi.fn()} availabilityHint="Anna · unavailable: 2026-12-15"/></div>);
    const bar = screen.getByRole('button',{name:/Open Near end/}), host = required(bar.parentElement), viewport = required(container.querySelector<HTMLElement>('[data-gantt-scroll]'));
    const bubble = screen.getByRole('tooltip',{hidden:true});
    vi.spyOn(viewport,'getBoundingClientRect').mockReturnValue(new DOMRect(100,0,800,100));
    const hostRect = vi.spyOn(host,'getBoundingClientRect').mockReturnValue(new DOMRect(-8180,0,10000,24));
    const anchorRect = vi.spyOn(bar,'getBoundingClientRect').mockReturnValue(new DOMRect(820,0,36,20));
    vi.spyOn(bubble,'getBoundingClientRect').mockReturnValue(new DOMRect(0,0,250,32));
    await user.hover(bar); expect(bubble).toHaveStyle({left:'8822px'});
    hostRect.mockReturnValue(new DOMRect(-8280,0,10000,24)); anchorRect.mockReturnValue(new DOMRect(720,0,36,20));
    fireEvent.scroll(viewport); expect(bubble).toHaveStyle({left:'8922px'});
    await user.unhover(bar); expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

});
