import {useUnsavedChangesWarning} from '../../lib/useUnsavedChangesWarning';
import type {TaskFieldDefinitionDto,TaskFieldPolicyDto} from '@workloom/contracts';
import {Button,TextInput} from '@workloom/ui';
import {useId,useState,type FormEvent} from 'react';
import {useTranslation} from '../../i18n';
import {SaveFeedback} from '../../shared/SaveFeedback';
import {QueryErrorState} from '../../shared/QueryErrorState';
import {useCurrentFieldPolicyOwner,useFieldPolicyQuery,type useSetFieldPolicyMutation} from './policy-queries';

/** Reject normalized invalid days and nonexistent local DST times; display and edit in the viewer's zone. */
export function localDeadlineToUtc(value:string):string|null {
  if(value==='')return null;
  const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if(!m)throw new Error('FIELD_POLICY_INVALID_LOCAL_DEADLINE');
  const [year,month,day,hour,minute]=m.slice(1).map(Number);
  if(year===undefined||month===undefined||day===undefined||hour===undefined||minute===undefined)throw new Error('FIELD_POLICY_INVALID_LOCAL_DEADLINE');
  const date=new Date(0);date.setFullYear(year,month-1,day);date.setHours(hour,minute,0,0);
  if(date.getFullYear()!==year||date.getMonth()!==month-1||date.getDate()!==day||date.getHours()!==hour||date.getMinutes()!==minute)throw new Error('FIELD_POLICY_INVALID_LOCAL_DEADLINE');
  return date.toISOString();
}
export function utcDeadlineToLocal(value:string|null):string {
  if(value===null)return '';
  const date=new Date(value),pad=(n:number)=>String(n).padStart(2,'0');
  return `${String(date.getFullYear()).padStart(4,'0')}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
type PolicyMutation=ReturnType<typeof useSetFieldPolicyMutation>;
interface Props {actorId:string;workspaceId:string;field:TaskFieldDefinitionDto;mutation:PolicyMutation}
export function FieldPolicyPanel({actorId,workspaceId,field,mutation}:Props) {
  const {t}=useTranslation(),owner=useCurrentFieldPolicyOwner(actorId,workspaceId);
  const held=mutation.pendingCommand?.variables??mutation.uncertain?.variables??null;
  const ownHeld=held?.fieldId===field.id?held:null;
  const [expanded,setExpanded]=useState(false);
  const query=useFieldPolicyQuery(actorId,workspaceId,field.id,expanded||ownHeld!==null);
  return <details open={expanded||ownHeld!==null} onToggle={e=>setExpanded(e.currentTarget.open)} className="mt-4 rounded-lg border border-line p-3">
    <summary className="cursor-pointer text-sm font-medium">{t('fieldRules.rules')}</summary>
    <div className="mt-3 space-y-3">
      <p className="text-xs text-muted">{t('fieldRules.summary')}</p>
      {query.data?<PolicyForm key={field.id} policy={query.data} owner={owner} busy={query.isFetching||query.isError} mutation={mutation} fieldId={field.id}/>:query.isError?<QueryErrorState error={query.error} subject="fields" headingLevel={3} onRetry={()=>void query.refetch()}/>:<p role="status">{t('fieldRules.loading')}</p>}
    </div>
  </details>;
}
function PolicyForm({policy,owner,busy,mutation,fieldId}:{policy:TaskFieldPolicyDto;owner:boolean;busy:boolean;mutation:PolicyMutation;fieldId:string}) {
  const {t}=useTranslation(),id=useId();
  // A dirty policy draft owns its original revision; background data never rebases or replaces it.
  const [edit,setEdit]=useState<{base:TaskFieldPolicyDto;deadline:string;limit:string}|null>(null);
  const deadline=edit?.deadline??utcDeadlineToLocal(policy.lockAt);
  const limit=edit?.limit??(policy.maxChangesPerActor===null?'':String(policy.maxChangesPerActor));
  const change=(part:Partial<{deadline:string;limit:string}>)=>setEdit(current=>({...(current??{base:policy,deadline,limit}),...part}));
  const stale=edit!==null&&edit.base.revision!==policy.revision;
  const [invalid,setInvalid]=useState(false);
  const held=mutation.pendingCommand?.variables??mutation.uncertain?.variables??null;
  const own=held?.fieldId===fieldId?held:null;
  const locked=!owner||held!==null;
  useUnsavedChangesWarning(edit!==null||own!==null);
  const timezone=Intl.DateTimeFormat().resolvedOptions().timeZone;
  const submit=(event:FormEvent)=>{
    event.preventDefault();event.stopPropagation();
    if(!owner||busy||held||mutation.hasOtherProtectedCommands())return;
    try {
      const lockAt=localDeadlineToUtc(deadline);
      if(limit!==''&&(!/^\d+$/.test(limit)||Number(limit)>1_000_000))throw new Error('FIELD_POLICY_INVALID_LIMIT');
      setInvalid(false);
      mutation.mutate({fieldId,input:{expectedRevision:edit?.base.revision??policy.revision,lockAt,maxChangesPerActor:limit===''?null:Number(limit)}},{onSuccess:()=>setEdit(null)});
    } catch {setInvalid(true);}
  };
  const shownDeadline=own?utcDeadlineToLocal(own.input.lockAt):deadline;
  const shownLimit=own?(own.input.maxChangesPerActor===null?'':String(own.input.maxChangesPerActor)):limit;
  return <form onSubmit={submit} className="space-y-3" noValidate>
    {stale?<div role="status" className="rounded-lg bg-canvas p-2 text-sm text-ink-soft"><p>{t('fieldRules.changedWhileEditing')}</p><Button type="button" size="sm" aria-disabled={held!==null||undefined} onClick={()=>{if(!held){setEdit(null);setInvalid(false);mutation.reset();}}}>{t('fieldRules.loadCurrent')}</Button></div>:null}
    <div><label htmlFor={`${id}-deadline`} className="block text-sm">{t('fieldRules.deadline',{timezone})}</label>
      <TextInput id={`${id}-deadline`} type="datetime-local" value={shownDeadline} onChange={e=>change({deadline:e.target.value})} disabled={locked} className="mt-1 w-full"/>
    </div>
    <div><label htmlFor={`${id}-limit`} className="block text-sm">{t('fieldRules.limit')}</label>
      <TextInput id={`${id}-limit`} type="text" inputMode="numeric" value={shownLimit} onChange={e=>change({limit:e.target.value})} disabled={locked} className="mt-1 w-full"/>
      <p className="mt-1 text-xs text-muted">{t('fieldRules.limitHint')}</p>
    </div>
    {!owner?<p className="text-xs text-muted">{t('fieldRules.ownerOnly')}</p>:null}
    {invalid?<p role="alert" className="text-sm text-danger">{t('fieldRules.invalid')}</p>:null}
    <SaveFeedback error={mutation.variables?.fieldId===fieldId?mutation.error:null} uncertainError={own?(mutation.uncertain?.error??null):null} subject="fieldValueSave"/>
    {owner?<div className="flex flex-wrap gap-2">
      {own&&mutation.uncertain?<Button type="button" onClick={()=>mutation.retryUncertain({onSuccess:()=>setEdit(null)})}>{t('fieldRules.retry')}</Button>:<Button type="submit" aria-disabled={busy||held!==null||undefined}>{mutation.pendingCommand?t('fieldRules.saving'):t('fieldRules.save')}</Button>}
    </div>:null}
  </form>;
}
