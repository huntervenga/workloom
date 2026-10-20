import { useState } from 'react';
import { CalendarDays } from 'lucide-react';
import { Button, TextInput } from '@workloom/ui';
import { updateProjectInputSchema, type ProjectDto } from '@workloom/contracts';
import { useTranslation } from '../../i18n';
import { useProtectedDraft } from '../../lib/protectedDrafts';
import { DialogShell } from '../../shared/DialogShell';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { useUpdateProjectMutation } from './queries';
/** Optional project bounds are metadata. They never reschedule tasks or make a week mandatory. */
export function ProjectDateRange({ actorId, workspaceId, project, writable }: { actorId: string; workspaceId: string; project: ProjectDto; writable: boolean }) {
 const { t } = useTranslation();
 const command = useUpdateProjectMutation(actorId, workspaceId);
 const [draft, setDraft] = useState<{revision:number;from:string;to:string}|null>(null);
 const held=command.pendingCommand!==null||command.uncertain!==null;
 useProtectedDraft(draft!==null);
 const dates=project.dateRange;
 const label=dates?t('genericReports.tableAggregates.projectRangeValue',{from:dates.from,to:dates.to}):t('genericReports.tableAggregates.projectDates');
 const input=draft?{expectedRevision:draft.revision,dateRange:draft.from||draft.to?{from:draft.from,to:draft.to}:null}:null;
 const valid=input!==null&&updateProjectInputSchema.safeParse(input).success;
 const done=()=>setDraft(null);
 if(!writable)return dates?<span className="text-xs text-muted">{label}</span>:null;
 return <><button type="button" disabled={held} onClick={()=>setDraft({revision:project.revision,from:dates?.from??'',to:dates?.to??''})} className="inline-flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs text-muted outline-none hover:bg-canvas focus-visible:ring-2 focus-visible:ring-accent"><CalendarDays size={13} aria-hidden="true"/>{label}</button>
 <DialogShell open={draft!==null} onOpenChange={open=>{if(!open&&!held)setDraft(null);}} title={t('genericReports.tableAggregates.projectDates')} description={t('genericReports.tableAggregates.projectDatesHelp')}><div className="space-y-3"><div className="grid grid-cols-2 gap-2"><label className="text-xs text-muted">{t('genericReports.from')}<TextInput type="date" value={draft?.from??''} disabled={held} onChange={event=>{if(draft)setDraft({...draft,from:event.target.value});}}/></label><label className="text-xs text-muted">{t('genericReports.to')}<TextInput type="date" value={draft?.to??''} disabled={held} onChange={event=>{if(draft)setDraft({...draft,to:event.target.value});}}/></label></div>
 <Button size="sm" variant="ghost" disabled={held} onClick={()=>{if(draft)setDraft({...draft,from:'',to:''});}}>{t('genericReports.tableAggregates.clearProjectDates')}</Button>
 {draft&&project.revision!==draft.revision?<p role="status" className="text-xs text-muted">{t('genericReports.staleDraft')}</p>:null}
 <SaveFeedback error={command.error} uncertainError={command.uncertain?.error??null} subject="projectSave"/>{command.uncertain?<Button size="sm" disabled={command.pendingCommand!==null} onClick={()=>command.retryUncertain({onSuccess:done})}>{t('genericReports.retry')}</Button>:null}
 <div className="flex gap-2 border-t border-line pt-3"><Button size="sm" disabled={!valid||held||command.hasOtherProtectedCommands()} onClick={()=>{if(input)command.mutate({projectId:project.id,input},{onSuccess:done});}}>{t('genericReports.tableAggregates.saveProjectDates')}</Button><Button size="sm" variant="ghost" disabled={held} onClick={()=>setDraft(null)}>{t('genericReports.discard')}</Button></div></div></DialogShell></>;
}
