import type { CutoffBlockedCode, CutoffReadinessDto } from '@workloom/contracts';
import { Button } from '@workloom/ui';
import { useEffect } from 'react';
import { useTranslation, type TranslationKey } from '../../i18n';
import { isAccessDenied } from '../../lib/api';
import { QueryErrorState } from '../../shared/QueryErrorState';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { useCutoffReadiness } from './queries';
import type { CutoffWorkspace } from './useCutoffWorkspace';
const readinessKeys={planning:'cutoff.status.planning',overdue_waiting:'cutoff.status.overdue_waiting',preparing_calendar:'cutoff.status.preparing_calendar',blocked:'cutoff.status.blocked',frozen:'cutoff.status.frozen'} satisfies Record<CutoffReadinessDto['readiness'],TranslationKey>;
const automationKeys={not_configured:'cutoff.automation.not_configured',enabled:'cutoff.automation.enabled',revoked:'cutoff.automation.revoked'} satisfies Record<CutoffReadinessDto['automation']['state'],TranslationKey>;
const blockerKeys={automation_not_configured:'cutoff.blocker.automation_not_configured',cutoff_grant_revoked:'cutoff.blocker.cutoff_grant_revoked',cutoff_grant_stale:'cutoff.blocker.cutoff_grant_stale',cutoff_authorizer_inactive:'cutoff.blocker.cutoff_authorizer_inactive',cutoff_authorizer_capability_revoked:'cutoff.blocker.cutoff_authorizer_capability_revoked',authorization_missing:'cutoff.blocker.authorization_missing',authorizer_inactive:'cutoff.blocker.authorizer_inactive',authorizer_capability_revoked:'cutoff.blocker.authorizer_capability_revoked',authorization_revision_stale:'cutoff.blocker.authorization_revision_stale',cross_period_conflict:'cutoff.blocker.cross_period_conflict',candidate_limit_exceeded:'cutoff.blocker.candidate_limit_exceeded',source_unavailable:'cutoff.blocker.source_unavailable',unsupported_event_version:'cutoff.blocker.unsupported_event_version'} satisfies Record<CutoffBlockedCode,TranslationKey>;
interface Props {actorId:string;workspaceId:string;periodId:string;timezone:string;canManage:boolean;controller:CutoffWorkspace;onFreeze:()=>void;onManageCalendar:(seriesId:string|null)=>void}
export function CutoffPanel({actorId,workspaceId,periodId,timezone,canManage,controller,onFreeze,onManageCalendar}:Props){
 const {t,formatDate}=useTranslation();const query=useCutoffReadiness(actorId,workspaceId,periodId);const {command,held}=controller;
 const observeReadiness=controller.observeReadiness;
 useEffect(()=>{if(query.isSuccess&&!query.isFetching)observeReadiness(query.data,query.dataUpdatedAt);},[query.isSuccess,query.isFetching,query.data,query.dataUpdatedAt,observeReadiness]);
 const ownError=command.variables?.periodId===periodId?command.error:null;
 const denial=[query.error,ownError].find(isAccessDenied);
 const date=(value:string)=>formatDate(value,{timeZone:timezone,dateStyle:'short',timeStyle:'short'});
 if(denial||query.isError)return <section aria-label={t('cutoff.heading')} className="rounded-lg border border-line p-3"><QueryErrorState error={denial??query.error} subject="planning" headingLevel={2} retrying={query.isFetching} onRetry={()=>{if(isAccessDenied(ownError))command.reset();void query.refetch();}}/></section>;
 if(!query.data)return <p role="status" className="text-xs text-muted">{t('cutoff.loading')}</p>;
 const data=query.data;const frozen=data.persistedState==='frozen';const current=!query.isFetching;const allowed=current&&canManage&&!held;
 const configure=(enabled:boolean)=>{if(!allowed||!data.actions.canConfigure)return;command.mutate({kind:'configure',periodId,input:{expectedPeriodRevision:data.periodRevision,expectedGrantRevision:data.automation.grant?.revision??0,enabled}});};
 const retry=()=>{if(!allowed||!data.actions.canRetry||!data.automation.grant)return;command.mutate({kind:'retry',periodId,input:{expectedPeriodRevision:data.periodRevision,expectedGrantRevision:data.automation.grant.revision}});};
 return <section aria-label={t('cutoff.heading')} className="rounded-lg border border-line bg-surface px-3 py-2.5 text-xs">
  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1"><p className="font-medium" role="status">{t(readinessKeys[data.readiness])}</p><div className="flex flex-wrap gap-2">{canManage&&data.actions.canFreezeProject?<Button size="sm" disabled={!allowed} onClick={onFreeze}>{t('planning.saveProjectBaseline')}</Button>:null}<Button size="sm" variant="ghost" disabled={query.isFetching} onClick={()=>void query.refetch()}>{query.isFetching?t('cutoff.refreshing'):t('cutoff.refresh')}</Button></div></div>
  <p className="text-muted">{t('cutoff.deadline',{time:date(data.cutoffAt),timezone})}</p>
  <p className="text-muted">{t('cutoff.checkedAt',{time:date(data.serverNow)})}</p>
  {data.baseline?<p className="mt-1 text-muted">{t('cutoff.savedAt',{requestedAt:date(data.baseline.requestedCutoffAt),frozenAt:date(data.baseline.frozenAt)})}</p>:null}
  {data.readiness==='overdue_waiting'||data.readiness==='preparing_calendar'?<p className="mt-1 text-muted">{t(data.readiness==='overdue_waiting'?'cutoff.waitingHelp':'cutoff.preparingHelp')}</p>:null}
  {data.blockedCount>0||data.missingCount>0?<p className="mt-1 text-muted">{t('cutoff.calendarSummary',{missingCount:data.missingCount,blockedCount:data.blockedCount})}</p>:null}
  {data.blockers.length>0?<details className="mt-2"><summary className="w-fit cursor-pointer font-medium text-accent-ink">{t('cutoff.blockers',{count:data.blockers.length})}</summary><ul className="space-y-2 pt-2">{data.blockers.map((blocker,index)=><li key={`${blocker.code}:${blocker.bindingId??''}:${index}`} className="flex flex-wrap items-center gap-2"><span className="min-w-0 flex-1">{t(blockerKeys[blocker.code])}</span>{blocker.kind==='recurrence'?<Button size="sm" variant="ghost" onClick={()=>onManageCalendar(blocker.seriesId)}>{t('cutoff.reviewCalendar')}</Button>:null}</li>)}</ul>{data.truncated?<p className="pt-2 text-muted">{t('cutoff.moreBlockers')}</p>:null}</details>:data.truncated?<p className="mt-1 text-muted">{t('cutoff.moreBlockers')}</p>:null}
  <details className="mt-2"><summary className="w-fit cursor-pointer font-medium text-accent-ink">{t('cutoff.automaticFreeze')}</summary><div className="space-y-2 pt-2"><p>{t(automationKeys[data.automation.state])}</p><p className="text-muted">{t('cutoff.automationHelp')}</p><p className="text-muted">{t('cutoff.pausedHelp')}</p>
   {data.latestRequest&&(data.latestRequest.state==='scheduled'||data.latestRequest.state==='pending')?<p className="text-muted">{t('cutoff.requestScheduled',{time:date(data.latestRequest.notBefore)})}</p>:null}
   <div className="flex flex-wrap gap-2">{canManage&&data.actions.canConfigure?<>{data.automation.state!=='enabled'?!frozen?<Button size="sm" disabled={!allowed} onClick={()=>configure(true)}>{t('cutoff.enable')}</Button>:null:<><Button size="sm" disabled={!allowed} onClick={()=>configure(false)}>{t('cutoff.turnOff')}</Button>{!frozen?<Button size="sm" variant="ghost" disabled={!allowed} onClick={()=>configure(true)}>{t('cutoff.renew')}</Button>:null}</>}</>:null}{canManage&&!frozen&&data.actions.canRetry?<Button size="sm" disabled={!allowed} onClick={retry}>{t('cutoff.retryProcessing')}</Button>:null}</div>
  </div></details>
  <SaveFeedback subject="planning" error={ownError} uncertainError={command.uncertain?.variables.periodId===periodId?command.uncertain.error:null}/>
  {command.isSuccess&&command.variables.periodId===periodId?<p role="status" className="mt-2 text-muted">{t('cutoff.confirmed')}</p>:null}
 </section>;
}
export function CutoffRecovery({controller,canManage,onOpen}:{controller:CutoffWorkspace;canManage:boolean;onOpen:(periodId:string)=>void}){
 const {t}=useTranslation();const {command,held}=controller;const original=useCutoffReadiness(controller.actorId,controller.workspaceId,held?.variables.periodId??'');if(!held)return null;
 const mayRecover=canManage&&original.isSuccess&&!original.isFetching&&original.data.actions.canConfigure&&!isAccessDenied(command.error);
 return <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs"><span className="min-w-0 flex-1">{command.pendingCommand?t('cutoff.pending'):t('cutoff.unknown')}</span><Button size="sm" onClick={()=>onOpen(held.variables.periodId)}>{t('cutoff.openOriginal')}</Button>{command.uncertain&&mayRecover?<Button size="sm" onClick={()=>command.retryUncertain()}>{t('cutoff.retryOriginal')}</Button>:null}</div>;
}
