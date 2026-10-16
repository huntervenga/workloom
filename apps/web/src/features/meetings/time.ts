import { t, formatDate } from '../../i18n';
import { Temporal } from 'temporal-polyfill';

export type ClockResolution = { kind: 'valid'; instant: string; label: string } | { kind: 'overlap'; earlier: string; later: string; earlierLabel: string; laterLabel: string } | { kind: 'invalid'; message: string };
/** Never normalizes a missing wall time or silently chooses one side of an overlap. */
export function resolveMeetingClock(local: string, timezone: string): ClockResolution {
  try {
    const wall = Temporal.PlainDateTime.from(local);
    const earlier = wall.toZonedDateTime(timezone, { disambiguation: 'earlier' });
    const later = wall.toZonedDateTime(timezone, { disambiguation: 'later' });
    if (!earlier.toPlainDateTime().equals(wall) || !later.toPlainDateTime().equals(wall)) return { kind: 'invalid', message: t('meetings.thisLocalTimeDoesNotExistBecauseOfA') };
    const instant = earlier.toInstant().toString({ smallestUnit: 'millisecond' });
    if (earlier.epochNanoseconds !== later.epochNanoseconds) return { kind: 'overlap', earlier: instant, later: later.toInstant().toString({ smallestUnit: 'millisecond' }), earlierLabel: `${earlier.offset} · ${instant}`, laterLabel: `${later.offset} · ${later.toInstant().toString()}` };
    return { kind: 'valid', instant, label: `${earlier.offset} · ${instant}` };
  } catch { return { kind: 'invalid', message: t('meetings.enterADateTimeAndValidIanaTimeZone') }; }
}
export function meetingLocal(instant: string, timezone: string): string {
  return Temporal.Instant.from(instant).toZonedDateTimeISO(timezone).toPlainDateTime().toString({ smallestUnit: 'minute' });
}
export function meetingTime(instant: string, timezone: string): string {
  return formatDate(new Date(instant), { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' }) + ` · ${timezone}`;
}

export function clockChoice(instant:string,timezone:string):string {
 const resolution=resolveMeetingClock(meetingLocal(instant,timezone),timezone);
 if(resolution.kind!=='overlap')return '';
 return Temporal.Instant.from(instant).epochMilliseconds >= Temporal.Instant.from(resolution.later).epochMilliseconds?'later':'earlier';
}
/** Unchanged wall inputs retain seconds, fractional seconds and their original overlap offset. */
export function meetingDraftInstant(local:string,timezone:string,choice:string,baseInstant:string,baseTimezone:string):string|null {
 const sameWall=timezone===baseTimezone&&local===meetingLocal(baseInstant,baseTimezone);
 if(sameWall&&choice===clockChoice(baseInstant,baseTimezone))return baseInstant;
 const wall=sameWall?Temporal.Instant.from(baseInstant).toZonedDateTimeISO(baseTimezone).toPlainDateTime().toString():local;
 const result=resolveMeetingClock(wall,timezone);
 return result.kind==='valid'?result.instant:result.kind==='overlap'?(choice==='earlier'?result.earlier:choice==='later'?result.later:null):null;
}
