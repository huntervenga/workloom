// Two extra synthetic members in this test's fresh private project only; no main data or invitations.
import {randomUUID} from 'node:crypto';
import postgres from 'postgres';
import {membershipListResponseSchema} from '@workloom/contracts';
import {requirePrivateMembershipDatabase} from './private-membership-fixture.js';
import {apiRead,type DailyProject} from './asana-private-project.js';
export async function fivePersonRoster(f:DailyProject){
 const url=requirePrivateMembershipDatabase(),sql=postgres(url.href,{max:1,connect_timeout:5,idle_timeout:3,onnotice:()=>{}});
 try{await sql.begin(async tx=>{
  const[identity]=await tx`select current_database() as database,current_user as username,host(inet_server_addr()) as host,inet_server_port() as port`;
  if(identity?.database!==decodeURIComponent(url.pathname.slice(1))||identity.username!=='workloom_qa'||identity.host!=='127.0.0.1'||identity.port!==60651)throw Error('Private roster connection mismatch.');
  const[scope]=await tx`select extract(epoch from(now()-w.created_at))::int as age,(select count(*)::int from memberships where workspace_id=w.id) as members,(select count(*)::int from projects where workspace_id=w.id) as projects,(select count(*)::int from tasks where workspace_id=w.id) as tasks from workspaces w join memberships m on m.workspace_id=w.id join users u on u.id=m.user_id where w.id=${f.workspaceId} and m.user_id=${f.actorId} and m.role='owner' and m.state='active' and u.kind='real' for update of w`;
  if(!scope||scope.age<0||scope.age>300||scope.members!==3||scope.projects!==1||scope.tasks!==0)throw Error('Expected fresh private owner project with two existing synthetic teammates.');
  for(const name of['Native teammate C','Native teammate D']){const user=randomUUID(),member=randomUUID();await tx`insert into users(id,display_name,kind) values(${user},${name},'fixture')`;await tx`insert into memberships(id,workspace_id,user_id,role) values(${member},${f.workspaceId},${user},'member')`;}
  await tx`update workspaces set permission_epoch=permission_epoch+1,updated_at=now() where id=${f.workspaceId}`;
 });}finally{await sql.end({timeout:5});}
 const members=(await apiRead(f.page,`${f.prefix}/memberships`,membershipListResponseSchema)).data;if(members.length!==5)throw Error('Expected five private participants.');return members;
}
