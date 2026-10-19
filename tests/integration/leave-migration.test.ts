// Validates a real 0020 database upgrade in an isolated synthetic PostgreSQL child, never main.
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,writeFile,copyFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe,expect,it} from 'vitest';
import {createDatabase,runMigrations,MIGRATIONS_FOLDER,readExpectedMigrations,seedDemoData,createTaskApplication,createGenericReportApplication,FIXTURE_USER_IDS as U,FIXTURE_WORKSPACE_IDS as W,type Database} from '@workloom/db';
import type {CommandContext} from '@workloom/domain';
import {createThrowawayDatabase,type ThrowawayDatabase} from './support/test-database.js';
import {requireTestDatabaseUrl} from './support/test-database-url.js';
import {databaseSnapshot} from './support/p1b.js';
requireTestDatabaseUrl();
const context=():CommandContext=>({workspaceId:W.team,actor:{userId:U.owner,displayName:'Synthetic migration actor',kind:'fixture'},source:'web',requestId:randomUUID(),idempotencyKey:randomUUID()});
describe('0021 additive Time off migration',()=>{
 it('preserves every old row, schema definition, immutable report snapshot and migration hash prefix; creates eight empty tables only',async()=>{
  let target:ThrowawayDatabase|undefined,db:Database|undefined;const folder=await mkdtemp(join(tmpdir(),'workloom-leave-migration-'));
  try{
   await mkdir(join(folder,'meta'));const journal=JSON.parse(await readFile(join(MIGRATIONS_FOLDER,'meta/_journal.json'),'utf8'))as{entries:{idx:number;tag:string}[]};journal.entries=journal.entries.filter(e=>e.idx<=20);await writeFile(join(folder,'meta/_journal.json'),JSON.stringify(journal));for(const entry of journal.entries)await copyFile(join(MIGRATIONS_FOLDER,entry.tag+'.sql'),join(folder,entry.tag+'.sql'));
   target=await createThrowawayDatabase('leave_upgrade');await runMigrations(target.url,{requireLoopback:true,migrationsFolder:folder});db=createDatabase(target.url,{requireLoopback:true});await seedDemoData(db);const tasks=createTaskApplication(db),reports=createGenericReportApplication(db);const project=await tasks.createProject(context(),{name:'Synthetic retained planning'}),template=await reports.template(context(),project.id,{planName:'Budget',factName:'Spent',reportName:'Retained',expectedColumnsRevision:1});const query=await reports.query(context(),template.report.id,{expectedRevision:1,offset:0,limit:100,snapshotId:null});await reports.capture(context(),template.report.id,{expectedRevision:1,name:'Unchanged original',expectedSourceVersion:query.sourceVersion});
   const before=await databaseSnapshot(db.sql),ledger=await db.sql`select * from drizzle.__drizzle_migrations order by id`;
   const schema=await db.sql`select c.relname,pg_get_constraintdef(k.oid) as definition,k.conname from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' order by c.relname,k.conname`;
   await runMigrations(target.url,{requireLoopback:true});const after=await databaseSnapshot(db.sql);expect(after.changeSeq).toEqual(before.changeSeq);for(const name of Object.keys(before.rows)){expect(after.rows[name],name).toBe(before.rows[name]);expect(after.rowDigests[name],name).toBe(before.rowDigests[name]);}
   const added=Object.keys(after.rows).filter(name=>!Object.hasOwn(before.rows,name));expect(added.sort()).toEqual(['leave_settings','leave_settings_versions','leave_profiles','leave_profile_versions','leave_requests','leave_request_versions','leave_charge_ledger','leave_adjustments'].sort());for(const name of added)expect(after.rows[name]).toBe(0);
   const newLedger=await db.sql`select * from drizzle.__drizzle_migrations order by id`;expect(newLedger.slice(0,ledger.length)).toEqual(ledger);expect(newLedger).toHaveLength(ledger.length+1);expect(readExpectedMigrations().at(-1)?.tag).toBe('0021_time_off');
   const newSchema=await db.sql`select c.relname,pg_get_constraintdef(k.oid) as definition,k.conname from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname not like 'leave_%' order by c.relname,k.conname`;expect(newSchema).toEqual(schema);
  }finally{await db?.close();await target?.drop();await rm(folder,{recursive:true,force:true});}
 },120000);
});
