import { userAvatarSql } from '../avatars/projection.js';
import {randomUUID} from 'node:crypto';
import {and,asc,eq} from 'drizzle-orm';
import * as C from '@workloom/contracts';
import {DomainError,type LeaveRepository,type LeaveStoredSource} from '@workloom/domain';
import type {WorkloomExecutor} from '../client.js';
import {leaveSettings,leaveSettingsVersions,leaveProfiles,leaveProfileVersions,leaveRequests,leaveRequestVersions,leaveChargeLedger,leaveAdjustments,workspaces,memberships,users} from '../schema.js';
import {createTaskRepository} from '../repositories/task-repository.js';
const overflow = ()=>{throw new DomainError('DOMAIN_VALIDATION_FAILED','Time off exceeds the bounded workspace source limit; no partial result was produced.');};
export function createLeaveRepository(tx:WorkloomExecutor,workspaceId:string):LeaveRepository {
 const receipts=createTaskRepository(tx);
 return {
 async isRealUser(userId){const [row]=await tx.select({kind:users.kind}).from(users).where(eq(users.id,userId));return row?.kind==='real';},
 async source():Promise<LeaveStoredSource>{
  const [policy]=await tx.select().from(leaveSettings).where(eq(leaveSettings.workspaceId,workspaceId));
  const profiles=await tx.select().from(leaveProfiles).where(eq(leaveProfiles.workspaceId,workspaceId)).orderBy(asc(leaveProfiles.membershipId)).limit(1001);
  const requests=await tx.select().from(leaveRequests).where(eq(leaveRequests.workspaceId,workspaceId)).orderBy(asc(leaveRequests.id)).limit(5001);
  const adjustments=await tx.select().from(leaveAdjustments).where(eq(leaveAdjustments.workspaceId,workspaceId)).orderBy(asc(leaveAdjustments.id)).limit(5001);
  const members=await tx.select({id:memberships.id,workspaceId:memberships.workspaceId,userId:memberships.userId,displayName:users.displayName,avatarUrl:userAvatarSql(),role:memberships.role,state:memberships.state,revision:memberships.revision}).from(memberships).innerJoin(users,eq(users.id,memberships.userId)).where(eq(memberships.workspaceId,workspaceId)).orderBy(asc(memberships.id)).limit(1001);
  if(profiles.length>1000||requests.length>5000||adjustments.length>5000||members.length>1000)overflow();
  const [head]=await tx.select({seq:workspaces.changeSeq,epoch:workspaces.permissionEpoch}).from(workspaces).where(eq(workspaces.id,workspaceId));
  return {settings:policy?C.leaveSettingsSchema.parse(policy.snapshot):null,profiles:profiles.map(r=>C.leaveProfileSchema.parse(r.snapshot)),requests:requests.map(r=>C.leaveStoredRequestSchema.parse(r.snapshot)),adjustments:adjustments.map(r=>C.leaveAdjustmentSchema.parse(r.snapshot)),members,head:`${head?.seq??0}:${head?.epoch??0}`};
 },
 async saveSettings(value,actor,reason,at){
  if(value.revision===1)await tx.insert(leaveSettings).values({workspaceId,revision:value.revision,snapshot:value,updatedAt:at});
  else {const rows=await tx.update(leaveSettings).set({revision:value.revision,snapshot:value,updatedAt:at}).where(and(eq(leaveSettings.workspaceId,workspaceId),eq(leaveSettings.revision,value.revision-1))).returning({id:leaveSettings.workspaceId});if(rows.length!==1)throw new DomainError('REVISION_CONFLICT','Time off settings changed.');}
  await tx.insert(leaveSettingsVersions).values({workspaceId,revision:value.revision,snapshot:value,actorMembershipId:actor,reason,recordedAt:at});
 },
 async saveProfile(value,actor,reason,at){
  const row={workspaceId,membershipId:value.membershipId,revision:value.revision,snapshot:value,updatedAt:at};
  if(value.revision===1)await tx.insert(leaveProfiles).values(row);
  else {const rows=await tx.update(leaveProfiles).set({revision:value.revision,snapshot:value,updatedAt:at}).where(and(eq(leaveProfiles.workspaceId,workspaceId),eq(leaveProfiles.membershipId,value.membershipId),eq(leaveProfiles.revision,value.revision-1))).returning({id:leaveProfiles.membershipId});if(rows.length!==1)throw new DomainError('REVISION_CONFLICT','Employment profile changed.');}
  await tx.insert(leaveProfileVersions).values({workspaceId,membershipId:value.membershipId,revision:value.revision,snapshot:value,actorMembershipId:actor,reason,recordedAt:at});
 },
 async saveRequest(value,before,actor,reason,at){
  const row={id:value.id,workspaceId,membershipId:value.membershipId,revision:value.revision,snapshot:value,updatedAt:at};
  if(value.revision===1)await tx.insert(leaveRequests).values(row);
  else {const rows=await tx.update(leaveRequests).set({revision:value.revision,snapshot:value,updatedAt:at}).where(and(eq(leaveRequests.workspaceId,workspaceId),eq(leaveRequests.id,value.id),eq(leaveRequests.revision,value.revision-1))).returning({id:leaveRequests.id});if(rows.length!==1)throw new DomainError('REVISION_CONFLICT','Absence request changed.');}
  await tx.insert(leaveRequestVersions).values({workspaceId,requestId:value.id,revision:value.revision,snapshot:value,actorMembershipId:actor,reason,recordedAt:at});
  const prior=new Map((before?.status==='approved'?before.chargedDays:[]).map(d=>[d.date,d]));
  const next=new Map((value.status==='approved'?value.chargedDays:[]).map(d=>[d.date,d]));
  for(const date of [...new Set([...prior.keys(),...next.keys()])].sort()){
   const old=prior.get(date),current=next.get(date),delta=(current?.microdays??0)-(old?.microdays??0);
   if(delta!==0)await tx.insert(leaveChargeLedger).values({id:randomUUID(),workspaceId,requestId:value.id,requestRevision:value.revision,membershipId:value.membershipId,typeId:value.typeId,date,deltaMicrodays:delta,scheduledMinutes:current?.scheduledMinutes??old?.scheduledMinutes??0,recordedAt:at});
  }
 },
 async addAdjustment(value,actor,at){await tx.insert(leaveAdjustments).values({id:value.id,workspaceId,membershipId:value.membershipId,snapshot:value,actorMembershipId:actor,recordedAt:at});},
 receipt:(actor,command,key)=>receipts.findIdempotency(workspaceId,actor,command,key),
 saveReceipt:(actor,command,key,payloadHash,result,at)=>receipts.insertIdempotency({workspaceId,actorUserId:actor,command,idempotencyKey:key,payloadHash,result,createdAt:at.toISOString()}),
 };
}
