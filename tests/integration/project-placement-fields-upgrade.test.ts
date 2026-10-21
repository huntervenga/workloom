// Populated0028 ->0029 retargets exactly three foreign keys; never touches main PostgreSQL.
import {randomUUID} from 'node:crypto';
import {copyFile,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createDatabase,createSharedAuthStore,createTaskApplication,createTaskFieldApplication,runMigrations,type Database} from '@workloom/db';
import type {CommandContext} from '@workloom/domain';
import {expect,it} from 'vitest';
import {createThrowawayDatabase,type ThrowawayDatabase} from './support/test-database.js';
const migrations=fileURLToPath(new URL('../../packages/db/migrations/',import.meta.url));
const must=<T>(value:T|undefined):T=>{if(value===undefined)throw Error('Placement field upgrade fixture required');return value;};
it('preserves every populated row and immutable history while changing only the three project-task foreign keys',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'workloom-placement-fields-upgrade-'));let target:ThrowawayDatabase|undefined,db:Database|undefined;
 try{
  const journal=JSON.parse(await readFile(join(migrations,'meta/_journal.json'),'utf8')) as {entries:{idx:number;tag:string}[]};
  const prefix=journal.entries.filter(e=>e.idx<29);expect(prefix).toHaveLength(29);expect(prefix.at(-1)?.tag).toBe('0028_workspace_slugs');
  await mkdir(join(folder,'meta'));for(const e of prefix)await copyFile(join(migrations,e.tag+'.sql'),join(folder,e.tag+'.sql'));
  await writeFile(join(folder,'meta/_journal.json'),JSON.stringify({...journal,entries:prefix}));
  target=await createThrowawayDatabase('placement_upgrade');await runMigrations(target.url,{requireLoopback:true,migrationsFolder:folder});db=createDatabase(target.url,{requireLoopback:true});const sql=db.sql;
  const owner=await createSharedAuthStore(db).provisionIdentity({issuer:'https://auth.example.test',subject:randomUUID(),displayName:'Preserved owner',workspaceName:'Populated fields',timezone:'UTC'});
  const ctx=():CommandContext=>({workspaceId:owner.workspaceId,actor:{userId:owner.user.id,displayName:'Preserved owner',kind:'real'},source:'import',requestId:'placement-upgrade',idempotencyKey:randomUUID()});
  const tasks=createTaskApplication(db),fields=createTaskFieldApplication(db);
  const home=await tasks.createProject(ctx(),{name:'Preserved home'}),linked=await tasks.createProject(ctx(),{name:'Preserved linked'});
  const status=must((await tasks.listStatuses(ctx(),home.id)).find(s=>s.group==='todo'));
  const task=await tasks.createTask(ctx(),{projectId:home.id,statusId:status.id,title:'Preserved task'});
  if(!tasks.placements)throw new Error('Placement API required');
  await tasks.placements.attachTaskProject(ctx(),task.id,{projectId:linked.id,expectedTaskRevision:task.revision});
  const homeField=await fields.createField(ctx(),{projectId:home.id,name:'Hours',type:'duration',historyEnabled:true,locked:false,options:[]});
  const linkedField=await fields.createField(ctx(),{projectId:linked.id,name:'Hours',type:'duration',historyEnabled:true,locked:false,options:[]});
  await fields.setPolicy(ctx(),homeField.id,{expectedRevision:0,lockAt:null,maxChangesPerActor:2});
  await fields.setTaskValue(ctx(),task.id,homeField.id,{expectedRevision:0,expectedDefinitionRevision:1,value:{type:'duration',value:0}});
  const tables=await sql<{name:string}[]>`select tablename name from pg_tables where schemaname='public' order by tablename`;
  const quote=(v:string)=>'"'+v.replaceAll('"','""')+'"';
  async function rows(){const result:Record<string,string[]>={};for(const {name} of tables){const data=await sql.unsafe<{row:string}[]>('select row_to_json(t)::text row from public.'+quote(name)+' t');result[name]=data.map(v=>v.row).sort();}return result;}
  const before=await rows(),ledger=await sql`select * from drizzle.__drizzle_migrations order by id`;
  expect(before['task_field_values']).toHaveLength(1);expect(before['task_field_value_history']).toHaveLength(1);expect(before['task_field_policy_usage']).toHaveLength(1);expect(before['task_project_placements']).toHaveLength(2);
  const constraints=()=>sql<{name:string;table_name:string;target:string;definition:string;validated:boolean}[]>`select c.conname name,c.conrelid::regclass::text table_name,c.confrelid::regclass::text target,pg_get_constraintdef(c.oid) definition,c.convalidated validated from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname='public' order by c.conrelid::regclass::text,c.conname`;
  const oldConstraints=await constraints(),columns=await sql`select * from information_schema.columns where table_schema='public' order by table_name,ordinal_position`;
  const entry=must(journal.entries.find(e=>e.idx===29));expect(entry.tag).toBe('0029_project_placement_fields');await copyFile(join(migrations,entry.tag+'.sql'),join(folder,entry.tag+'.sql'));await writeFile(join(folder,'meta/_journal.json'),JSON.stringify({...journal,entries:[...prefix,entry]}));
  expect((await runMigrations(target.url,{requireLoopback:true,migrationsFolder:folder})).appliedNow).toEqual([entry.tag]);
  expect(await rows()).toEqual(before);expect(await sql`select * from information_schema.columns where table_schema='public' order by table_name,ordinal_position`).toEqual(columns);
  const changedNames=['task_field_values_task_fk','task_field_value_history_task_fk','task_field_policy_usage_task_fk'];
  const updated=await constraints();expect(updated.filter(c=>!changedNames.includes(c.name))).toEqual(oldConstraints.filter(c=>!changedNames.includes(c.name)));
  const changed=updated.filter(c=>changedNames.includes(c.name));expect(changed).toHaveLength(3);
  for(const fk of changed)expect(fk).toMatchObject({target:'task_project_placements',validated:true,definition:'FOREIGN KEY (workspace_id, task_id, project_id) REFERENCES task_project_placements(workspace_id, task_id, project_id)'});
  const afterLedger=await sql`select * from drizzle.__drizzle_migrations order by id`;expect(afterLedger.slice(0,ledger.length)).toEqual(ledger);expect(afterLedger).toHaveLength(30);
  expect((await runMigrations(target.url,{requireLoopback:true,migrationsFolder:folder})).appliedNow).toEqual([]);expect(await rows()).toEqual(before);
  await fields.setTaskValue(ctx(),task.id,linkedField.id,{expectedRevision:0,expectedDefinitionRevision:1,value:{type:'duration',value:90}});
  expect((await fields.listProjectValues(ctx(),home.id,{taskIds:[task.id]}))[0]?.value).toEqual({type:'duration',value:0});
  expect((await fields.listProjectValues(ctx(),linked.id,{taskIds:[task.id]}))[0]?.value).toEqual({type:'duration',value:90});
 }finally{await db?.close();await target?.drop();await rm(folder,{recursive:true,force:true});}
},60000);
