// Validates a real 0020 database upgrade in an isolated synthetic PostgreSQL child, never main.
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,writeFile,copyFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe,expect,it} from 'vitest';
import {createDatabase,runMigrations,MIGRATIONS_FOLDER,readExpectedMigrations,FIXTURE_USER_IDS as U,FIXTURE_WORKSPACE_IDS as W,type Database} from '@workloom/db';
import {createThrowawayDatabase,type ThrowawayDatabase} from './support/test-database.js';
import {requireTestDatabaseUrl} from './support/test-database-url.js';
import {seedLegacyDemoData} from './support/legacy-upgrade-fixture.js';
import {databaseSnapshot} from './support/p1b.js';
requireTestDatabaseUrl();
describe('0021 additive Time off migration',()=>{
 it('preserves every old row, schema definition, immutable report snapshot and migration hash prefix; creates eight empty tables only',async()=>{
  let target:ThrowawayDatabase|undefined,db:Database|undefined;const folder=await mkdtemp(join(tmpdir(),'workloom-leave-migration-'));
  try{
   await mkdir(join(folder,'meta'));const fullJournal=JSON.parse(await readFile(join(MIGRATIONS_FOLDER,'meta/_journal.json'),'utf8'))as{entries:{idx:number;tag:string}[]};const journal={...fullJournal,entries:fullJournal.entries.filter(e=>e.idx<=20)};await writeFile(join(folder,'meta/_journal.json'),JSON.stringify(journal));for(const entry of journal.entries)await copyFile(join(MIGRATIONS_FOLDER,entry.tag+'.sql'),join(folder,entry.tag+'.sql'));
   target=await createThrowawayDatabase('leave_upgrade');await runMigrations(target.url,{requireLoopback:true,migrationsFolder:folder});db=createDatabase(target.url,{requireLoopback:true});await seedLegacyDemoData(db.sql);
   // Bootstrap only columns that existed at0020; current project repositories require0023.
   const projectId=randomUUID(),reportId=randomUUID(),snapshotId=randomUUID(),now='2026-10-18T00:00:00.000Z',config={projectId,hierarchy:'all_tasks',filters:{statusGroups:[],tagIds:[],assignee:{kind:'all'},dateRange:null},groupBy:{kind:'none'},comparison:null,measures:[{key:'tasks',operation:'count_tasks'}]},definition={id:reportId,workspaceId:W.team,projectId,name:'Retained report',revision:1,config,archivedAt:null,createdAt:now,updatedAt:now},header={id:snapshotId,workspaceId:W.team,projectId,reportId,name:'Unchanged original',definitionRevision:1,config,fields:[],capturedAt:now,capturedByUserId:U.owner,sourceVersion:'a'.repeat(64),taskCount:0};
   await db.sql`insert into projects(id,workspace_id,name) values(${projectId},${W.team},'Synthetic retained planning')`;
   await db.sql`insert into generic_report_definitions(id,workspace_id,project_id,name,revision,config,created_at,updated_at) values(${reportId},${W.team},${projectId},${definition.name},1,${JSON.stringify(config)}::jsonb,${now},${now})`;
   await db.sql`insert into generic_report_definition_versions(workspace_id,project_id,report_id,revision,snapshot,created_at) values(${W.team},${projectId},${reportId},1,${JSON.stringify(definition)}::jsonb,${now})`;
   await db.sql`insert into generic_report_initial_snapshots(id,workspace_id,project_id,report_id,definition_revision,header,rows,"values",created_at) values(${snapshotId},${W.team},${projectId},${reportId},1,${JSON.stringify(header)}::jsonb,'[]'::jsonb,'[]'::jsonb,${now})`;
   const before=await databaseSnapshot(db.sql),ledger=await db.sql`select * from drizzle.__drizzle_migrations order by id`;
   const schema=await db.sql`select c.relname,pg_get_constraintdef(k.oid) as definition,k.conname from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' order by c.relname,k.conname`;
   journal.entries=fullJournal.entries.filter(e=>e.idx<=21);await copyFile(join(MIGRATIONS_FOLDER,'0021_time_off.sql'),join(folder,'0021_time_off.sql'));await writeFile(join(folder,'meta/_journal.json'),JSON.stringify(journal));await runMigrations(target.url,{requireLoopback:true,migrationsFolder:folder});const after=await databaseSnapshot(db.sql);expect(after.changeSeq).toEqual(before.changeSeq);for(const name of Object.keys(before.rows)){expect(after.rows[name],name).toBe(before.rows[name]);expect(after.rowDigests[name],name).toBe(before.rowDigests[name]);}
   const added=Object.keys(after.rows).filter(name=>!Object.hasOwn(before.rows,name));expect(added.sort()).toEqual(['leave_settings','leave_settings_versions','leave_profiles','leave_profile_versions','leave_requests','leave_request_versions','leave_charge_ledger','leave_adjustments'].sort());for(const name of added)expect(after.rows[name]).toBe(0);
   const newLedger=await db.sql`select * from drizzle.__drizzle_migrations order by id`;expect(newLedger.slice(0,ledger.length)).toEqual(ledger);expect(newLedger).toHaveLength(ledger.length+1);expect(readExpectedMigrations(folder).at(-1)?.tag).toBe('0021_time_off');
   const newSchema=await db.sql`select c.relname,pg_get_constraintdef(k.oid) as definition,k.conname from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname not like 'leave_%' order by c.relname,k.conname`;expect(newSchema).toEqual(schema);
  }finally{await db?.close();await target?.drop();await rm(folder,{recursive:true,force:true});}
 },120000);
});
