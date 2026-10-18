import {describe,it,expect,vi} from 'vitest';
import type {AccessRepository,TeamApplication,Actor} from '@workloom/domain';
import {createApp} from '../app.js';
import {loadConfig} from '../config.js';
const id=(n:number)=>`a0000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const actor:Actor={userId:id(1),displayName:'Synthetic actor',kind:'real'};
const repository:AccessRepository={findUser:async()=>null,findUsers:async()=>[],listAccessibleWorkspaces:async()=>[],findWorkspaceAccess:async()=>null,listActiveMemberships:async()=>[]};
describe('team request logging',()=>{
 it('keeps acceptance secrets, proof hashes, cookies and query values out of actual API logs',async()=>{
  const secret='B'.repeat(43),secretHash='c'.repeat(64),chunks:string[]=[];
  const team:TeamApplication={listTeam:vi.fn(),issueInvitation:vi.fn(),revokeInvitation:vi.fn(),updateMembership:vi.fn(),acceptInvitation:vi.fn(async()=>({workspaceId:id(9),membershipId:id(11)}))};
  // Pino uses the supplied stdout stream when its write method is intercepted; no file or provider is involved.
  const write=vi.spyOn(process.stdout,'write').mockImplementation(chunk=>{chunks.push(String(chunk));return true;});
  let app:Awaited<ReturnType<typeof createApp>>|undefined;
  try{
   app=await createApp(loadConfig({APP_ENV:'local',AUTH_MODE:'dev',DATABASE_URL:'postgres://u:p@127.0.0.1:5432/unused',APP_ORIGIN:'http://127.0.0.1:4310',LOG_LEVEL:'info'}),{accessRepository:repository,readiness:{check:async()=>({ready:true,checks:{database:'ok',schema:'ok'}})},identityAdapter:{mode:'shared',resolveActor:async()=>actor},teamApplication:team,webDistDir:null});
   const headers={host:'127.0.0.1:4310',origin:'http://127.0.0.1:4310','idempotency-key':'logging','x-workloom-actor-id':actor.userId,cookie:'session=do-not-log-cookie'};
   const response=await app.inject({method:'POST',url:'/api/v1/invitations/accept',headers,payload:{invitationId:id(500),secret}});expect(response.statusCode).toBe(200);
   const rejected=await app.inject({method:'POST',url:'/api/v1/invitations/accept?secret=do-not-log-query',headers,payload:{invitationId:id(500),secret}});expect(rejected.statusCode).toBe(400);
   app.log.info({body:{secret,secretHash}},'synthetic team redaction check');
   await app.close();app=undefined;
  }finally{await app?.close();write.mockRestore();}
  const logs=chunks.join('');expect(logs).toContain('/api/v1/invitations/accept');expect(logs).toContain('synthetic team redaction check');expect(logs).toContain('[redacted]');for(const value of [secret,secretHash,'do-not-log-cookie','do-not-log-query'])expect(logs).not.toContain(value);
 });
});
