// Explicit Node/tsx integration gate: creates and drops only its own child PostgreSQL database.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDatabase,createSharedAuthStore,runMigrations} from '@workloom/db';
import {createThrowawayDatabase} from '../tests/integration/support/test-database.ts';
import {prepareAsanaPlan,executeAsanaImport,parseSourceCsv} from './import-asana-project.mjs';
import {syntheticSource} from './import-asana-project.test-fixture.mjs';
test('real domain commands: bounded cross-batch import, lost-response resume, exact replay and revoked-owner rejection',{timeout:180000},async()=>{
 const target=await createThrowawayDatabase('asana_operator');let db;const dir=mkdtempSync(join(tmpdir(),'asana-operator-'));
 try{
  await runMigrations(target.url,{requireLoopback:true});db=createDatabase(target.url,{requireLoopback:true});
  const identity=await createSharedAuthStore(db).provisionIdentity({issuer:'https://auth.example.test',subject:randomUUID(),displayName:'Synthetic operator owner',workspaceName:'Synthetic import target',timezone:'UTC'});
  const [member]=await db.sql`select id from memberships where workspace_id=${identity.workspaceId} and user_id=${identity.user.id}`;
  const source=syntheticSource(identity.workspaceId,member.id),plan=prepareAsanaPlan({...source,workspaceId:identity.workspaceId});
  const options={databaseUrl:target.url,ownerUserId:identity.user.id,journalDir:dir,testMode:true};
  const pendingIds=[];
  for(const name of ['alice','bob']){const userId=randomUUID(),id=randomUUID();pendingIds.push(id);await db.sql`insert into users(id,display_name,kind) values(${userId},${'Synthetic '+name},'real')`;await db.sql`insert into memberships(id,workspace_id,user_id,role) values(${id},${identity.workspaceId},${userId},'member')`;await db.sql`insert into team_pending_members(workspace_id,membership_id,placeholder_user_id,first_name,last_name,email,created_at) values(${identity.workspaceId},${id},${userId},${name},'Synthetic',${name+'@example.test'},now())`;}
  const changed=JSON.parse(source.jsonText),csv=parseSourceCsv(source.csvText);
  for(const [i,name]of ['alice','bob'].entries()){const t=changed.data[i+1];t.assignee={gid:String(510+i),name:'Synthetic '+name};const r=csv.rows.find(r=>r['Task ID']===t.gid);r.Assignee=t.assignee.name;r['Assignee Email']=name+'@example.test';}
  const encode=rows=>rows.map(r=>r.map(v=>'"'+String(v).replaceAll('"','""')+'"').join(',')).join('\r\n')+'\r\n';
  const swappedMapping={...source.mapping,assignees:{...source.mapping.assignees,'alice@example.test':pendingIds[1],'bob@example.test':pendingIds[0]}};
  const swapped=prepareAsanaPlan({...source,jsonText:JSON.stringify(changed),csvText:encode([csv.headers,...csv.rows.map(r=>csv.headers.map(h=>r[h]))]),mapping:swappedMapping,workspaceId:identity.workspaceId});
  await assert.rejects(executeAsanaImport(swapped,{...options,journalDir:join(dir,'swapped')}),/without an exact approved alias/);
  const unapproved=prepareAsanaPlan({...source,mapping:{...source.mapping,approvedEmailAliases:{}},workspaceId:identity.workspaceId});
  await assert.rejects(executeAsanaImport(unapproved,{...options,journalDir:join(dir,'unapproved')}),/workspace-owner alias/);
  const [notWritten]=await db.sql`select count(*)::int n from projects`;assert.equal(notWritten.n,0);
  await assert.rejects(executeAsanaImport(plan,{...options,afterStep:async name=>{if(name==='apply.0')throw new Error('simulated process death after committed command');}}),/simulated process death/);
  const pending=JSON.parse(readFileSync(join(dir,'journal.json'),'utf8'));assert.equal(pending.steps['apply.0'].phase,'pending');
  const [partial]=await db.sql`select count(*)::int n from tasks`;assert.equal(partial.n,50);
  const completed=await executeAsanaImport(plan,options);assert.equal(completed.status,'verified');assert.deepEqual(completed.verification.differences,[]);
  const counts=()=>db.sql`select (select count(*) from projects)::int projects,(select count(*) from tasks)::int tasks,(select count(*) from external_import_references)::int refs,(select count(*) from project_imports)::int imports,(select count(*) from task_dependencies)::int edges,(select count(*) from task_field_values)::int values,(select count(*) from command_idempotency)::int receipts,(select count(*) from work_logs)::int worklogs,(select count(*) from plan_baselines)::int baselines`;
  const reviewedPlan=readFileSync(join(dir,'plan.json'),'utf8');await assert.rejects(executeAsanaImport({...plan,projectName:'Changed plan after review'},options),/Journal belongs/);assert.equal(readFileSync(join(dir,'plan.json'),'utf8'),reviewedPlan);
  const before=await counts();assert.deepEqual({...before[0],values:0,receipts:0},{projects:1,tasks:105,refs:105,imports:3,edges:1,values:0,receipts:0,worklogs:0,baselines:0});
  const again=await executeAsanaImport(plan,options);assert.equal(again.projectId,completed.projectId);assert.deepEqual(await counts(),before);
  await assert.rejects(executeAsanaImport(plan,{...options,journalDir:join(dir,'different-run')}),/already belong/);assert.deepEqual(await counts(),before);
  await db.sql`update memberships set state='revoked',revoked_at=now(),revision=revision+1 where id=${member.id}`;
  await assert.rejects(executeAsanaImport(plan,options),/active Auth-bound real workspace owner/);assert.deepEqual(await counts(),before);
 }finally{try{await db?.close();}finally{await target.drop();rmSync(dir,{recursive:true,force:true});}}
});
