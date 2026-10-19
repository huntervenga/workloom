import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { calendarWindow } from '../schedule/dates';
import { GanttAvailabilityBands, supportedAvailabilityWindow, unavailableDates } from './GanttAvailability';
import { ReportCapacityResults } from './ReportCapacityResults';
import { TimeOffCalendar } from './TimeOffCalendar';
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
    const window = required(calendarWindow('2026-10-19', 28));
    expect([...unavailableDates(availability(), MEMBER, window)].sort()).toEqual(['2026-10-20', '2026-10-23']);
    expect([...unavailableDates(availability(), OTHER, window)]).toEqual(['2026-10-23']);
    expect([...unavailableDates(availability(), null, window)]).toEqual(['2026-10-23']);
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
});
