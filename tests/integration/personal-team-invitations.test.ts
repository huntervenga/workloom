// All writes target this file's disposable PostgreSQL child, never the running Workloom database.
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {teamInvitationSecretPreimage} from '@workloom/contracts';
import {createAccessRepository,createDatabase,createSharedAuthStore,createTaskApplication,createTeamApplication,createWorkspaceCreateApplication,runMigrations,type Database} from '@workloom/db';
import type {CommandContext,TeamAcceptanceContext} from '@workloom/domain';
import {createThrowawayDatabase,type ThrowawayDatabase} from './support/test-database.js';
import {requireTestDatabaseUrl} from './support/test-database-url.js';
requireTestDatabaseUrl();
let target:ThrowawayDatabase|undefined,db:Database,other:Database,owner='',alice='',bob='';
const must=<T>(value:T|undefined):T=>{if(value===undefined)throw Error('Expected synthetic personal-invitation fixture.');return value;};
const actor=(userId:string,email:string|null=null,key=randomUUID()):TeamAcceptanceContext=>({actor:{userId,displayName:'Synthetic Auth user',kind:'real',verifiedEmail:email},source:'web',requestId:randomUUID(),idempotencyKey:key});
const scoped=(workspaceId:string,userId=owner,email:string|null=null,key=randomUUID()):CommandContext=>({...actor(userId,email,key),workspaceId});
const material=()=>{const id=randomUUID(),bytes=randomBytes(32);return{id,secret:bytes.toString('base64url'),secretHash:createHash('sha256').update(teamInvitationSecretPreimage(id,bytes)).digest('hex')};};
async function setup(){const workspace=await createWorkspaceCreateApplication(db).createWorkspace(actor(owner),{name:'Named pending people',timezone:'UTC'});return{workspaceId:workspace.id,app:createTeamApplication(db),second:createTeamApplication(other)};}
async function issue(s:Awaited<ReturnType<typeof setup>>,email='alice@example.com',key=randomUUID()){
 const m=material(),input={id:m.id,hashVersion:1 as const,secretHash:m.secretHash,role:'member' as const,expiresInSeconds:3600,recipient:{firstName:'Alice',lastName:'Example',email}};
 const metadata=await s.app.issueInvitation(scoped(s.workspaceId,owner,null,key),input);return{...m,input,metadata,accept:{invitationId:m.id,secret:m.secret}};
}
async function snapshot(workspaceId:string){
 const head=await db.sql`select change_seq,permission_epoch from workspaces where id=${workspaceId}`;
 const members=await db.sql`select * from memberships where workspace_id=${workspaceId} order by id`;
 const pending=await db.sql`select * from team_pending_members where workspace_id=${workspaceId} order by membership_id`;
 const invites=await db.sql`select * from team_invitations where workspace_id=${workspaceId} order by id`;
 const receipts=await db.sql`select * from command_idempotency where workspace_id=${workspaceId} order by idempotency_key`;
 const events=await db.sql`select * from audit_events where workspace_id=${workspaceId} order by change_seq,event_ordinal`;
 return{head,members,pending,invites,receipts,events};
}
beforeAll(async()=>{
 target=await createThrowawayDatabase('personal_team');await runMigrations(target.url,{requireLoopback:true});
 db=createDatabase(target.url,{requireLoopback:true});other=createDatabase(target.url,{requireLoopback:true});
 const store=createSharedAuthStore(db);
 for(const name of ['owner','alice','bob']){
  const result=await store.provisionIdentity({issuer:'https://auth.example.test',subject:randomUUID(),displayName:`${name} Actual`,workspaceName:`${name} home`,timezone:'UTC'});
  if(name==='owner')owner=result.user.id;else if(name==='alice')alice=result.user.id;else bob=result.user.id;
 }
},60000);
afterAll(async()=>{await db?.close();await other?.close();await target?.drop();});
describe('personal invitations and stable schedulable identities',()=>{
 it('rejects control characters in names before any database write',async()=>{
  const s=await setup(),m=material(),before=await snapshot(s.workspaceId);
  for(const name of ['A\0lice','Ali\nce']){
   await expect(s.app.issueInvitation(scoped(s.workspaceId),{id:m.id,hashVersion:1,secretHash:m.secretHash,role:'member',expiresInSeconds:3600,recipient:{firstName:name,lastName:'Example',email:'alice@example.com'}})).rejects.toMatchObject({code:'VALIDATION_FAILED'});
   expect(await snapshot(s.workspaceId)).toEqual(before);
  }
 });
 it('lists an invited person for assignment but never authenticates or authorizes their placeholder',async()=>{
  const s=await setup(),invite=await issue(s),members=await s.app.listTeam(scoped(s.workspaceId));
  const pending=must(members.members.find(m=>m.id===invite.metadata.pendingMembershipId));
  expect(pending).toMatchObject({displayName:'Alice Example',pending:true,email:'alice@example.com'});
  const access=createAccessRepository(db);
  expect(await access.findUser(pending.userId)).toBeNull();expect(await access.listAccessibleWorkspaces(pending.userId)).toEqual([]);
  expect(await access.findWorkspaceAccess(s.workspaceId,pending.userId)).toBeNull();
  expect(await access.listActiveMemberships(s.workspaceId)).toEqual(expect.arrayContaining([expect.objectContaining({id:pending.id,pending:true})]));
  await expect(s.app.listTeam(scoped(s.workspaceId,pending.userId))).rejects.toMatchObject({code:'CAPABILITY_REQUIRED'});
  await expect(createSharedAuthStore(db).createSession({userId:pending.userId,sessionHash:'a'.repeat(64),encryptedTokens:'synthetic-not-a-token',accessExpiresAt:new Date(Date.now()+60000).toISOString(),expiresAt:new Date(Date.now()+120000).toISOString()})).rejects.toThrow();
 });
 it('preserves preassigned task and membership IDs when the named mailbox joins',async()=>{
  const s=await setup(),invite=await issue(s),tasks=createTaskApplication(db),project=await tasks.createProject(scoped(s.workspaceId),{name:'Already planned'}),status=must((await tasks.listStatuses(scoped(s.workspaceId),project.id))[0]);
  const task=await tasks.createTask(scoped(s.workspaceId),{projectId:project.id,statusId:status.id,title:'Assigned before signup',responsibleMembershipId:invite.metadata.pendingMembershipId});
  const before=await db.sql`select to_jsonb(t)::text as row from tasks t where id=${task.id}`;
  const joined=await s.app.acceptInvitation(actor(alice,'alice@example.com'),invite.accept);
  expect(joined.membershipId).toBe(invite.metadata.pendingMembershipId);
  expect(await db.sql`select to_jsonb(t)::text as row from tasks t where id=${task.id}`).toEqual(before);
  expect((await tasks.getTask(scoped(s.workspaceId,alice,'alice@example.com'),task.id)).responsibleMembershipId).toBe(joined.membershipId);
  expect((await s.app.listTeam(scoped(s.workspaceId))).members.find(m=>m.id===joined.membershipId)).toMatchObject({userId:alice,pending:false});
 });
 it('requires current-session verified email; mismatches make no writes and other sessions cannot override the proof',async()=>{
  const s=await setup(),invite=await issue(s),before=await snapshot(s.workspaceId);
  for(const [userId,email,reason] of [[alice,null,'email_unverified'],[alice,'other@example.com','email_mismatch'],[bob,'bob@example.com','email_mismatch']] as const){
   await expect(s.app.acceptInvitation(actor(userId,email),invite.accept)).rejects.toMatchObject({code:'DOMAIN_VALIDATION_FAILED',details:{invitationReason:reason}});
   expect(await snapshot(s.workspaceId)).toEqual(before);
  }
  expect((await s.app.acceptInvitation(actor(alice,'alice@example.com'),invite.accept)).membershipId).toBe(invite.metadata.pendingMembershipId);
 });
 it('regenerates one person without duplicates, revokes old links, and exact old retries never revoke newer links',async()=>{
  const s=await setup(),key=randomUUID(),first=await issue(s,' ALICE@EXAMPLE.COM ',key),second=await issue(s);
  expect(second.metadata.pendingMembershipId).toBe(first.metadata.pendingMembershipId);
  expect((await s.app.listTeam(scoped(s.workspaceId))).members).toHaveLength(2);
  await expect(s.app.acceptInvitation(actor(alice,'alice@example.com'),first.accept)).rejects.toMatchObject({code:'NOT_FOUND'});
  const before=await snapshot(s.workspaceId);expect(await s.app.issueInvitation(scoped(s.workspaceId,owner,null,key),first.input)).toEqual(first.metadata);expect(await snapshot(s.workspaceId)).toEqual(before);
  expect((await s.app.acceptInvitation(actor(alice,'alice@example.com'),second.accept)).membershipId).toBe(first.metadata.pendingMembershipId);
 });
 it('refuses an old link after removing a pending member; a fresh owner link explicitly restores that same planning identity',async()=>{
  const s=await setup(),first=await issue(s),pending=must((await s.app.listTeam(scoped(s.workspaceId))).members.find(m=>m.id===first.metadata.pendingMembershipId));
  await s.app.updateMembership(scoped(s.workspaceId),pending.id,{expectedRevision:pending.revision,role:'member',state:'revoked'});
  const before=await snapshot(s.workspaceId);await expect(s.app.acceptInvitation(actor(alice,'alice@example.com'),first.accept)).rejects.toMatchObject({code:'NOT_FOUND'});expect(await snapshot(s.workspaceId)).toEqual(before);
  const fresh=await issue(s);expect(fresh.metadata.pendingMembershipId).toBe(pending.id);expect((await s.app.acceptInvitation(actor(alice,'alice@example.com'),fresh.accept)).membershipId).toBe(pending.id);
 });
 it('does not merge an existing separate membership into a pending person',async()=>{
  const s=await setup(),m=material();await s.app.issueInvitation(scoped(s.workspaceId),{id:m.id,hashVersion:1,secretHash:m.secretHash,role:'member',expiresInSeconds:3600});
  await s.app.acceptInvitation(actor(alice,'alice@example.com'),{invitationId:m.id,secret:m.secret});
  const named=await issue(s),before=await snapshot(s.workspaceId);
  await expect(s.app.acceptInvitation(actor(alice,'alice@example.com'),named.accept)).rejects.toMatchObject({details:{invitationReason:'member_conflict'}});expect(await snapshot(s.workspaceId)).toEqual(before);
 });
 it('rolls back the membership binding, pending claim, audit and receipt when invitation consumption fails late',async()=>{
  const s=await setup(),invite=await issue(s),before=await snapshot(s.workspaceId);
  await db.sql.unsafe("create function qa_personal_invite_fail() returns trigger language plpgsql as $$ begin if NEW.accepted_at is not null then raise exception 'synthetic late invitation failure'; end if; return NEW; end $$");
  await db.sql.unsafe('create trigger qa_personal_invite_fail before update on team_invitations for each row execute function qa_personal_invite_fail()');
  try{await expect(s.app.acceptInvitation(actor(alice,'alice@example.com'),invite.accept)).rejects.toMatchObject({cause:{message:'synthetic late invitation failure'}});expect(await snapshot(s.workspaceId)).toEqual(before);}
  finally{await db.sql.unsafe('drop trigger qa_personal_invite_fail on team_invitations');await db.sql.unsafe('drop function qa_personal_invite_fail()');}
  expect((await s.app.acceptInvitation(actor(alice,'alice@example.com'),invite.accept)).membershipId).toBe(invite.metadata.pendingMembershipId);
 });
 it('serializes same-actor acceptance and keeps two workspaces with the same email independent',async()=>{
  const a=await setup(),b=await setup(),first=await issue(a),second=await issue(b),key=randomUUID();
  expect(first.metadata.pendingMembershipId).not.toBe(second.metadata.pendingMembershipId);
  const results=await Promise.all([a.app.acceptInvitation(actor(alice,'alice@example.com',key),first.accept),a.second.acceptInvitation(actor(alice,'alice@example.com',key),first.accept)]);
  expect(results[0]).toEqual(results[1]);
  expect((await a.app.listTeam(scoped(a.workspaceId))).members).toHaveLength(2);
  expect((await b.app.listTeam(scoped(b.workspaceId))).members.find(m=>m.id===second.metadata.pendingMembershipId)?.pending).toBe(true);
  expect((await b.app.acceptInvitation(actor(alice,'alice@example.com'),second.accept)).membershipId).toBe(second.metadata.pendingMembershipId);
 });
});
