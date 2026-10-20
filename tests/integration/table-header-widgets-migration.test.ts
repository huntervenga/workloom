// Real 0021→0022 upgrade on a disposable child only; previous rows/receipts are never replaced.
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,writeFile,copyFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe,it,expect} from 'vitest';
import {createDatabase,runMigrations,MIGRATIONS_FOLDER,seedDemoData,FIXTURE_WORKSPACE_IDS as W,type Database} from '@workloom/db';
import {databaseSnapshot} from './support/p1b.js';
import {createThrowawayDatabase,type ThrowawayDatabase} from './support/test-database.js';
import {requireTestDatabaseUrl} from './support/test-database-url.js';
requireTestDatabaseUrl();
describe('0022 additive header preferences migration',()=>{
 it('adds one nullable column only, conserves every old value and ledger prefix, and replays idempotently',async()=>{
  let target:ThrowawayDatabase|undefined,db:Database|undefined;const folder=await mkdtemp(join(tmpdir(),'workloom-headers-upgrade-'));
  try{
   await mkdir(join(folder,'meta'));const fullJournal=JSON.parse(await readFile(join(MIGRATIONS_FOLDER,'meta/_journal.json'),'utf8'))as{entries:{idx:number;tag:string}[]};const journal={...fullJournal,entries:fullJournal.entries.filter(entry=>entry.idx<=21)};await writeFile(join(folder,'meta/_journal.json'),JSON.stringify(journal));for(const entry of journal.entries)await copyFile(join(MIGRATIONS_FOLDER,entry.tag+'.sql'),join(folder,entry.tag+'.sql'));
   target=await createThrowawayDatabase('headers_upgrade');await runMigrations(target.url,{requireLoopback:true,migrationsFolder:folder});db=createDatabase(target.url,{requireLoopback:true});await seedDemoData(db);const project={id:randomUUID()};await db.sql`insert into projects(id,workspace_id,name) values(${project.id},${W.team},'Retained aggregate settings')`;
   await db.sql`insert into generic_report_column_settings(workspace_id,project_id,revision,measures) values(${W.team},${project.id},1,${db.sql.json([{key:'tasks',operation:'count_tasks'}])})`;
   const before=await databaseSnapshot(db.sql),oldRows=await db.sql`select workspace_id,project_id,revision,measures from generic_report_column_settings order by workspace_id,project_id`,ledger=await db.sql`select * from drizzle.__drizzle_migrations order by id`,constraints=await db.sql`select c.relname,k.conname,pg_get_constraintdef(k.oid) as definition from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' order by c.relname,k.conname`;
   journal.entries=fullJournal.entries.filter(entry=>entry.idx<=22);await copyFile(join(MIGRATIONS_FOLDER,'0022_table_header_widgets.sql'),join(folder,'0022_table_header_widgets.sql'));await writeFile(join(folder,'meta/_journal.json'),JSON.stringify(journal));await runMigrations(target.url,{requireLoopback:true,migrationsFolder:folder});const after=await databaseSnapshot(db.sql);expect(after.rows).toEqual(before.rows);expect(after.changeSeq).toEqual(before.changeSeq);for(const table of Object.keys(before.rows))if(table!=='generic_report_column_settings')expect(after.rowDigests[table],table).toBe(before.rowDigests[table]);expect(await db.sql`select workspace_id,project_id,revision,measures from generic_report_column_settings order by workspace_id,project_id`).toEqual(oldRows);expect(await db.sql`select header_widgets from generic_report_column_settings`).toEqual([{header_widgets:null}]);
   const column=await db.sql`select is_nullable,column_default,data_type from information_schema.columns where table_schema='public' and table_name='generic_report_column_settings' and column_name='header_widgets'`;expect(column).toEqual([{is_nullable:'YES',column_default:null,data_type:'jsonb'}]);expect(await db.sql`select c.relname,k.conname,pg_get_constraintdef(k.oid) as definition from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and k.conname<>'generic_report_columns_header_widgets' order by c.relname,k.conname`).toEqual(constraints);
   const newLedger=await db.sql`select * from drizzle.__drizzle_migrations order by id`;expect(newLedger.slice(0,ledger.length)).toEqual(ledger);expect(newLedger).toHaveLength(ledger.length+1);await runMigrations(target.url,{requireLoopback:true,migrationsFolder:folder});expect(await databaseSnapshot(db.sql)).toEqual(after);expect(await db.sql`select * from drizzle.__drizzle_migrations order by id`).toEqual(newLedger);
  }finally{await db?.close();await target?.drop();await rm(folder,{recursive:true,force:true});}
 },120000);
});
