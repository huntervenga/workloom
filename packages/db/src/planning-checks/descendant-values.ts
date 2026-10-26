import {and,eq,inArray,isNull} from 'drizzle-orm';
import type {WorkloomExecutor} from '../client.js';
import {taskFieldValues,tasks} from '../schema.js';

/**
 * Field IDs (among `fieldIds`) that have a stored number/duration value on at least one descendant of the task. The
 * table shows such a sum in an empty parent cell, so a completion requirement counts it as filled.
 */
export async function filledDescendantFieldIds(tx:WorkloomExecutor,workspaceId:string,taskId:string,fieldIds:readonly string[]):Promise<string[]>{
 if(!fieldIds.length)return[];
 const visited=new Set<string>([taskId]),descendants:string[]=[];
 let frontier=[taskId];
 while(frontier.length&&descendants.length<5000){
  const rows=await tx.select({id:tasks.id}).from(tasks).where(and(eq(tasks.workspaceId,workspaceId),inArray(tasks.parentTaskId,frontier),isNull(tasks.archivedAt)));
  frontier=rows.map(row=>row.id).filter(id=>!visited.has(id));
  for(const id of frontier){visited.add(id);descendants.push(id);}
 }
 if(!descendants.length)return[];
 const filled=new Set<string>();
 for(let start=0;start<descendants.length;start+=1000){
  const rows=await tx.select({fieldId:taskFieldValues.fieldId,value:taskFieldValues.value}).from(taskFieldValues).where(and(eq(taskFieldValues.workspaceId,workspaceId),inArray(taskFieldValues.taskId,descendants.slice(start,start+1000)),inArray(taskFieldValues.fieldId,[...fieldIds])));
  for(const row of rows)if((row.value.type==='number'||row.value.type==='duration')&&typeof row.value.value==='number')filled.add(row.fieldId);
 }
 return[...filled];
}
