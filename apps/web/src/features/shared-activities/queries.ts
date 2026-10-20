import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConfigureSharedActivityInput, CreateSharedActivityInput, ConfirmSharedActivityAttendanceInput, SharedActivityRecordDto, SharedActivityConfiguration } from '@workloom/contracts';
import { useIdempotentMutation, type IdempotentVariables } from '../../lib/useIdempotentMutation';
import { queryKeys } from '../../lib/queryKeys';
import { useProtectedDraft } from '../../lib/protectedDrafts';
import { reportKeys } from '../generic-reports/queries';
import * as api from './api';
export const sharedActivityKey=(actor:string,workspace:string,task:string)=>[...queryKeys.fieldValues(actor,workspace),'shared-activity',task]as const;
export function useSharedActivityRecord(actor:string,workspace:string,task:string,taskRevision:number,enabled=true){return useQuery({queryKey:[...sharedActivityKey(actor,workspace,task),taskRevision],queryFn:({signal})=>api.fetchSharedActivity(workspace,task,signal),enabled,retry:false,staleTime:0});}
export interface SharedConfigurationDraft{configuration:SharedActivityConfiguration;record:SharedActivityRecordDto|null;taskRevision:number;planValueRevision:number;valueRevisions:Record<string,number>;baseline:string}
export interface SharedAttendanceDraft{contributionId:string;expectedRevision:number;attendance:'unconfirmed'|'present'|'partial'|'absent';minutes:string;reason:string;void:boolean;selected:boolean}
export interface SharedTaskDraft{setup?:SharedConfigurationDraft;attendance?:{record:SharedActivityRecordDto;rows:SharedAttendanceDraft[];baseline:string}}
/** Project lifetime owns commands and drafts, rather than the task pane's mount lifecycle. */
export function useSharedActivityWorkspace(actor:string,workspace:string,project:string){
 const client=useQueryClient(),[createOpen,setCreateOpen]=useState(false),[drafts,setDrafts]=useState<Record<string,SharedTaskDraft>>({}),[createDirty,setCreateDirty]=useState(false);
 const invalidate=async()=>{await Promise.all([client.invalidateQueries({queryKey:queryKeys.tasks(actor,workspace)}),client.invalidateQueries({queryKey:queryKeys.fieldValues(actor,workspace)}),client.invalidateQueries({queryKey:reportKeys.root(actor,workspace)})]);};
 const configure=useIdempotentMutation({prepare:({taskId,input}:IdempotentVariables&{taskId:string;input:ConfigureSharedActivityInput})=>api.configureActivityRequest(workspace,taskId,input),onSuccess:invalidate});
 const attendance=useIdempotentMutation({prepare:({taskId,input}:IdempotentVariables&{taskId:string;input:ConfirmSharedActivityAttendanceInput})=>api.confirmAttendanceRequest(workspace,taskId,input),onSuccess:invalidate});
 const create=useIdempotentMutation({prepare:({input}:IdempotentVariables&{input:CreateSharedActivityInput})=>api.createActivityRequest(workspace,project,input),onSuccess:async result=>{client.setQueryData(queryKeys.task(actor,workspace,result.task.id),result.task);await invalidate();}});
 useProtectedDraft(createDirty||Object.values(drafts).some(draft=>draft.setup&&JSON.stringify(draft.setup.configuration)!==draft.setup.baseline||draft.attendance&&JSON.stringify(draft.attendance.rows)!==draft.attendance.baseline));
 const setTaskDraft=(id:string,draft:SharedTaskDraft)=>setDrafts(before=>({...before,[id]:draft}));
 return{actorId:actor,workspaceId:workspace,projectId:project,createOpen,setCreateOpen,createDirty,setCreateDirty,drafts,setTaskDraft,configure,attendance,create};
}
export type SharedActivityWorkspace=ReturnType<typeof useSharedActivityWorkspace>;
