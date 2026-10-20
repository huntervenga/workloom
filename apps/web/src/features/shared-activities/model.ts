import { configureSharedActivityInputSchema, confirmSharedActivityAttendanceInputSchema, type SharedActivityConfiguration, type SharedActivityRecordDto, type TaskDto } from '@workloom/contracts';
import type { SharedAttendanceDraft, SharedConfigurationDraft } from './queries';
import type { TaskCommands } from '../tasks/useTaskCommands';
import { autosaveRetains } from '../tasks/taskAutosave';
export function emptyActivityConfiguration(person:string,date=''):SharedActivityConfiguration{return{planFieldId:'',factFieldId:'',categoryFieldId:null,organizerMembershipId:person,attendeeMembershipIds:person?[person]:[],occurrenceDate:date,startAt:null,recordingUrl:null,summaryUrl:null,summaryText:null,plannedOverrides:[]};}
export function configurationFromRecord(record:SharedActivityRecordDto):SharedActivityConfiguration{const{activity,contributions}=record;return{planFieldId:activity.planFieldId,factFieldId:activity.factFieldId,categoryFieldId:activity.categoryFieldId,organizerMembershipId:activity.organizerMembershipId,attendeeMembershipIds:contributions.filter(row=>row.rosterActive).map(row=>row.membershipId),occurrenceDate:activity.occurrenceDate,startAt:activity.startAt,recordingUrl:activity.recordingUrl,summaryUrl:activity.summaryUrl,summaryText:activity.summaryText,plannedOverrides:contributions.filter(row=>row.rosterActive&&row.plannedOverride).map(row=>({membershipId:row.membershipId,minutes:row.currentPlannedMinutes}))};}
export function attendanceRows(record:SharedActivityRecordDto):SharedAttendanceDraft[]{return record.contributions.filter(row=>row.rosterActive||row.postingState!=='unconfirmed').map(row=>({contributionId:row.id,expectedRevision:row.revision,attendance:row.attendance,minutes:row.minutes===null?'':String(row.minutes),reason:'',void:row.postingState==='void',selected:false}));}
export function attendanceInput(record:SharedActivityRecordDto,rows:readonly SharedAttendanceDraft[]){
 const selected=rows.filter(row=>row.selected);
 const valid=selected.every(row=>{
  const source=record.contributions.find(item=>item.id===row.contributionId);if(!source||source.revision!==row.expectedRevision)return false;
  const allowed=source.membershipId===record.permissions.selfMembershipId?record.permissions.canWriteSelf:record.permissions.canWriteOthers;if(!allowed)return false;
  const minutes=row.attendance==='partial'?Number(row.minutes):row.attendance==='present'?record.actualDurationMinutes:row.attendance==='absent'?0:null;
  if(!row.void&&(row.attendance==='present'||row.attendance==='partial')&&(record.actualDurationMinutes===null||minutes===null))return false;
  if(row.attendance==='partial'&&(!row.minutes.trim()||!Number.isSafeInteger(minutes)||Number(minutes)<1||Number(minutes)>(record.actualDurationMinutes??0)))return false;
  if((row.void||(source.postingState!=='unconfirmed'||source.confirmedActivityRevision!==null)&&(source.attendance!==row.attendance||source.minutes!==minutes||source.postingState==='void'||source.confirmedDurationMinutes!==record.actualDurationMinutes||source.confirmedActivityRevision!==record.activity.revision))&&!row.reason.trim())return false;
  return true;
 });
 const candidates=selected.map(row=>({contributionId:row.contributionId,expectedRevision:row.expectedRevision,attendance:row.attendance,...(row.attendance==='partial'?{minutes:row.minutes.trim()===''?NaN:Number(row.minutes)}:{}),...(row.void?{void:true}:{}),...(row.reason.trim()?{reason:row.reason.trim()}:{})}));
 return confirmSharedActivityAttendanceInputSchema.safeParse({expectedActivityRevision:record.activity.revision,expectedFactValueRevision:record.factValueRevision,rows:valid?candidates:[]});
}
export const validConfiguration=(taskRevision:number,activityRevision:number,planValueRevision:number,configuration:SharedActivityConfiguration)=>configureSharedActivityInputSchema.safeParse({expectedTaskRevision:taskRevision,expectedActivityRevision:activityRevision,expectedPlanValueRevision:planValueRevision,configuration});
/** Internal command boundary failure: structured machine state, never rendered as error prose. */
export class SharedActivityCommandBlockedError extends Error {
 constructor(readonly state:{kind:'ordinary_save_unresolved'|'context_changed'}){super();this.name='SharedActivityCommandBlockedError';}
}
/** Flush ordinary autosave first; a rejected/unknown command requires its own explicit recovery. */
export async function flushBeforeSharedCommand(commands:TaskCommands,taskId:string,reload:()=>Promise<TaskDto>):Promise<TaskDto>{
 commands.autosave.flush(taskId);
 const ready=()=>{const entry=commands.autosave.get(taskId);if(entry&&(entry.phase==='unknown'||entry.phase==='conflict'||entry.phase==='rejected'))throw new SharedActivityCommandBlockedError({kind:'ordinary_save_unresolved'});return !autosaveRetains(entry);};
 if(!ready())await new Promise<void>((resolve,reject)=>{let dispose:()=>void=()=>undefined;const check=()=>{try{if(ready()){dispose();resolve();}}catch(error){dispose();reject(error);}};dispose=commands.autosave.subscribe(check);check();});
 return reload();
}

export function configurationPlanRevision(draft:SharedConfigurationDraft):number{return draft.record?.activity.planFieldId===draft.configuration.planFieldId?draft.planValueRevision:draft.valueRevisions[draft.configuration.planFieldId]??0;}
