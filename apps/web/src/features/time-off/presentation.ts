import { Temporal } from 'temporal-polyfill';
import type { LeavePolicyVersionDto, LeaveSettingsDto } from '@workloom/contracts';

export const MICRODAYS = 1_000_000;
export function daysText(microdays: number, locale = 'en'): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(microdays / MICRODAYS);
}
export function hoursText(minutes: number, locale = 'en'): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(minutes / 60);
}
export function monthRange(date: string): { startDate: string; endDate: string } {
  const start = Temporal.PlainDate.from(date).with({ day: 1 });
  return { startDate: start.toString(), endDate: start.with({ day: start.daysInMonth }).toString() };
}
export function rangeDates(startDate: string, endDate: string): string[] {
  const end = Temporal.PlainDate.from(endDate); const days: string[] = [];
  for (let date = Temporal.PlainDate.from(startDate); Temporal.PlainDate.compare(date, end) <= 0 && days.length < 366; date = date.add({ days: 1 })) days.push(date.toString());
  return days;
}
export function policyForYear(settings: LeaveSettingsDto, year: number): LeavePolicyVersionDto | undefined {
  return [...settings.policyVersions].filter(version => version.effectiveYear <= year).sort((a, b) => b.effectiveYear - a.effectiveYear)[0];
}
export function futureDate(today: string): string { return Temporal.PlainDate.from(today).add({ days: 1 }).toString(); }
