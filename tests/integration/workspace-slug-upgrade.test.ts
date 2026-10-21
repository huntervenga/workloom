// Populated owned0027 -> additive0028. Never points at the user's main database.
import {randomUUID} from 'node:crypto';
import {copyFile,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createDatabase,runMigrations,type Database} from '@workloom/db';
import {expect,it} from 'vitest';
import {createLegacyProject,createLegacyTask,insertLegacyAuthPrincipal,insertLegacyAuthSession,sha256Hex} from './support/legacy-upgrade-fixture.js';
import {createThrowawayDatabase,type ThrowawayDatabase} from './support/test-database.js';
import {requireTestDatabaseUrl} from './support/test-database-url.js';
requireTestDatabaseUrl();
const must=<T>(value:T|undefined):T=>{if(value===undefined)throw Error('Expected synthetic upgrade fixture.');return value;};
const migrations=fileURLToPath(new URL('../../packages/db/migrations/',import.meta.url));
it('adds optional company addresses without rewriting any existing value or ledger receipt',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'workloom-slug-upgrade-'));let target:ThrowawayDatabase|undefined,db:Database|undefined;
 try{
  const journal=JSON.parse(await readFile(join(migrations,'meta/_journal.json'),'utf8')) as {entries:{idx:number;tag:string}[]};
  const oldPrefix=journal.entries.filter(entry=>entry.idx<28);expect(oldPrefix).toHaveLength(28);expect(oldPrefix.at(-1)?.tag).toBe('0027_personal_team_invitations');
  await mkdir(join(folder,'meta'));for(const entry of oldPrefix)await copyFile(join(migrations,`${entry.tag}.sql`),join(folder,`${entry.tag}.sql`));
  await writeFile(join(folder,'meta/_journal.json'),JSON.stringify({...journal,entries:oldPrefix}));
  target=await createThrowawayDatabase('slug_upgrade');await runMigrations(target.url,{requireLoopback:true,migrationsFolder:folder});db=createDatabase(target.url,{requireLoopback:true});const sql=db.sql;
  const owner=await insertLegacyAuthPrincipal(sql,{issuer:'https://auth.example.test',subject:randomUUID(),displayName:'Preserved owner',workspaceName:'Preserved owner home',timezone:'UTC'});
  const project=await createLegacyProject(sql,owner,'Preserved planning project');await createLegacyTask(sql,owner,{projectId:project.id,statusId:project.todoStatusId,title:'Preserved prior task',estimateMinutes:90});
  const expires=new Date(Date.now()+3600000).toISOString();await insertLegacyAuthSession(sql,{sessionHash:sha256Hex('upgrade-personal-session'),userId:owner.userId,encryptedTokens:'opaque-synthetic-session',accessExpiresAt:expires,expiresAt:expires});
  await sql`insert into team_invitations(id,workspace_id,secret_hash,hash_version,role,created_by_user_id,created_by_membership_id,created_at,expires_at) values(${randomUUID()},${owner.workspaceId},${sha256Hex('upgrade-invite')},1,'member',${owner.userId},${owner.membershipId},now(),now()+interval '1 hour')`;
  const tables=await sql<{name:string}[]>`select tablename name from pg_tables where schemaname='public' order by tablename`;expect(tables.length).toBeGreaterThan(80);
  const columns=()=>sql<{table_name:string;column_name:string;data_type:string;is_nullable:string;column_default:string|null}[]>`select table_name::text,column_name::text,data_type::text,is_nullable::text,column_default::text from information_schema.columns where table_schema='public' order by table_name,ordinal_position`;
  const oldColumns=await columns(),selected=new Map<string,string[]>();for(const c of oldColumns)selected.set(c.table_name,[...(selected.get(c.table_name)??[]),c.column_name]);
  const quote=(s:string)=>`"${s.replaceAll('"','""')}"`;
  async function rows(){const result:Record<string,string[]>={};for(const {name} of tables){const values=await sql.unsafe<{row:string}[]>(`select to_jsonb(t)::text row from (select ${(selected.get(name)??[]).map(quote).join(',')} from public.${quote(name)}) t`);result[name]=values.map(v=>v.row).sort();}return result;}
  const before=await rows(),ledger=await sql`select * from drizzle.__drizzle_migrations order by id`;
  expect(before['tasks']).toHaveLength(1);expect(before['team_invitations']).toHaveLength(1);expect(must(before['audit_events']).length).toBeGreaterThan(0);expect(must(before['command_idempotency']).length).toBeGreaterThan(0);
  const addition=must(journal.entries.find(e=>e.idx===28));expect(addition.tag).toBe('0028_workspace_slugs');await copyFile(join(migrations,`${addition.tag}.sql`),join(folder,`${addition.tag}.sql`));await writeFile(join(folder,'meta/_journal.json'),JSON.stringify({...journal,entries:[...oldPrefix,addition]}));
  expect((await runMigrations(target.url,{requireLoopback:true,migrationsFolder:folder})).appliedNow).toEqual([addition.tag]);
  expect(await rows()).toEqual(before);const afterColumns=await columns();expect(afterColumns.filter(c=>selected.get(c.table_name)?.includes(c.column_name))).toEqual(oldColumns);
  expect(afterColumns.filter(c=>c.table_name==='workspaces'&&!selected.get(c.table_name)?.includes(c.column_name))).toEqual([
   {table_name:'workspaces',column_name:'slug',data_type:'text',is_nullable:'YES',column_default:null},
   {table_name:'workspaces',column_name:'slug_revision',data_type:'integer',is_nullable:'NO',column_default:'1'},
  ]);
  expect(await sql`select slug,slug_revision from workspaces`).toEqual([{slug:null,slug_revision:1}]);
  const addedTables=(await sql<{name:string}[]>`select tablename name from pg_tables where schemaname='public' order by tablename`).filter(t=>!tables.some(old=>old.name===t.name)).map(t=>t.name);expect(addedTables).toEqual(['workspace_slug_aliases']);
  expect(await sql`select count(*)::int n from workspace_slug_aliases`).toEqual([{n:0}]);
  const afterLedger=await sql`select * from drizzle.__drizzle_migrations order by id`;expect(afterLedger.slice(0,ledger.length)).toEqual(ledger);expect(afterLedger).toHaveLength(29);
  expect((await runMigrations(target.url,{requireLoopback:true,migrationsFolder:folder})).appliedNow).toEqual([]);expect(await rows()).toEqual(before);expect(await sql`select * from drizzle.__drizzle_migrations order by id`).toEqual(afterLedger);
 }finally{await db?.close();await target?.drop();await rm(folder,{recursive:true,force:true});}
});
