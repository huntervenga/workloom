import { useTranslation } from '../../i18n';
import { TextInput, inputClassName } from '@workloom/ui';
import { useId } from 'react';
import { meetingDraftInstant, resolveMeetingClock } from './time';
export function resolvedClock(local:string,zone:string,choice:string):string|null {
 const result=resolveMeetingClock(local,zone); return result.kind==='valid'?result.instant:result.kind==='overlap'?(choice==='earlier'?result.earlier:choice==='later'?result.later:null):null;
}
export function ClockInput({label,local,zone,choice,onChange,disabled=false,fixedZone=false,baseInstant,baseTimezone}:{label:string;local:string;zone:string;choice:string;onChange:(local:string,zone:string,choice:string)=>void;disabled?:boolean;fixedZone?:boolean;baseInstant?:string|undefined;baseTimezone?:string|undefined}) {
  const { t } = useTranslation();
 const id=useId(); const result=resolveMeetingClock(local,zone);
 const instant=baseInstant?meetingDraftInstant(local,zone,choice,baseInstant,baseTimezone??zone):resolvedClock(local,zone,choice);
 return <fieldset disabled={disabled} className="min-w-0 space-y-3"><div className="space-y-1.5"><label htmlFor={`${id}-local`} className="text-sm font-medium">{label}</label><TextInput id={`${id}-local`} type="datetime-local" value={local} onChange={e=>onChange(e.target.value,zone,'')} /></div><div className="space-y-1.5"><label htmlFor={`${id}-zone`} className="text-sm font-medium">{t('meetings.meetingTimeZone')}</label><TextInput id={`${id}-zone`} disabled={fixedZone} value={zone} placeholder={t('meetings.timeZoneExample')} onChange={e=>onChange(local,e.target.value,'')} /></div>{local&&result.kind==='invalid'?<p role="alert" className="text-xs text-red-700">{result.message}</p>:null}{result.kind==='overlap'?<div className="space-y-1.5"><label htmlFor={`${id}-offset`} className="text-sm font-medium">{t('meetings.thisLocalTimeOccursTwiceChooseAnOffset')}</label><select id={`${id}-offset`} className={inputClassName()} value={choice} onChange={e=>onChange(local,zone,e.target.value)}><option value="">{t('meetings.chooseExplicitly')}</option><option value="earlier">{t('meetings.first2', { earlierLabel: result.earlierLabel })}</option><option value="later">{t('meetings.second2', { laterLabel: result.laterLabel })}</option></select></div>:null}{local&&instant?<p className="text-xs text-muted">{t('meetings.willSave2', { instant: instant, zone: zone })}</p>:null}</fieldset>;
}
