import type { RecordedWorkLogDto } from '@workloom/contracts';
/** Source precision is explicit; occurrence facts must never masquerade as period-wide input. */
export function recordedWorkLabel(log:RecordedWorkLogDto):string {
 if(log.sourceKind==='manual_period')return 'За неделю';
 const instant=log.attribution.basis==='planned_absence'?log.attribution.plannedStartAt:log.attribution.actualStartAt;
 const stamp=new Intl.DateTimeFormat('ru',{timeZone:'UTC',dateStyle:'short',timeStyle:'short'}).format(new Date(instant));
 return `${log.attribution.basis==='planned_absence'?'Плановое отсутствие':'Присутствие на встрече'} · ${stamp} UTC`;
}
export function RecordedWorkLabel({log}:{log:RecordedWorkLogDto}) {return <span>{recordedWorkLabel(log)}</span>;}
