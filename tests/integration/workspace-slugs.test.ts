import {randomUUID} from 'node:crypto';
import {createAccessRepository,createDatabase,createWorkspaceSlugApplication,runMigrations,type Database} from '@workloom/db';
import type {CommandContext} from '@workloom/domain';
import {expect,it} from 'vitest';
import {insertLegacyAuthPrincipal,type LegacyActor} from './support/legacy-upgrade-fixture.js';
import {createThrowawayDatabase} from './support/test-database.js';
import {requireTestDatabaseUrl} from './support/test-database-url.js';
requireTestDatabaseUrl();
const context=(a:LegacyActor,key=randomUUID()):CommandContext=>({actor:{userId:a.userId,displayName:'Synthetic owner',kind:'real'},workspaceId:a.workspaceId,source:'import',requestId:randomUUID(),idempotencyKey:key});
const owner=(db:Database)=>insertLegacyAuthPrincipal(db.sql,{issuer:'https://auth.example.test',subject:randomUUID(),displayName:'Synthetic owner',workspaceName:'Synthetic company',timezone:'UTC'});
it('retains aliases and exact receipts, authorizes current owners, and makes namespace races atomic',async()=>{
 const target=await createThrowawayDatabase('slugs');let db:Database|undefined,other:Database|undefined;
 try{await runMigrations(target.url,{requireLoopback:true});db=createDatabase(target.url,{requireLoopback:true});other=createDatabase(target.url,{requireLoopback:true});
  const a=await owner(db),b=await owner(db),sql=db.sql,app=createWorkspaceSlugApplication(db),second=createWorkspaceSlugApplication(other),ctx=context(a),input={slug:' BALANCY ',expectedSlugRevision:1};
  const first=await app.updateSlug(ctx,input);expect(first).toMatchObject({id:a.workspaceId,slug:'balancy',slugRevision:2,slugAliases:['balancy']});
  expect(await app.updateSlug(ctx,input)).toEqual(first);
  const renamed=await app.updateSlug(context(a),{slug:'balancy-team',expectedSlugRevision:2});expect(renamed).toMatchObject({slugRevision:3,slugAliases:['balancy','balancy-team']});
  const reads=createAccessRepository(db.db);expect((await reads.listAccessibleWorkspaces(a.userId))[0]?.workspace.slugAliases).toEqual(['balancy','balancy-team']);
  expect((await reads.listAccessibleWorkspaces(b.userId))[0]?.workspace.slugAliases).toEqual([]);
  await expect(app.updateSlug(context(b),{slug:'balancy',expectedSlugRevision:1})).rejects.toMatchObject({code:'DOMAIN_VALIDATION_FAILED',details:{workspaceSlugReason:'unavailable'}});
  await expect(app.updateSlug(context(a),{slug:'stale-address',expectedSlugRevision:2})).rejects.toMatchObject({code:'REVISION_CONFLICT'});
  await sql`update memberships set role='admin' where id=${a.membershipId}`;
  await expect(app.updateSlug(ctx,input)).rejects.toMatchObject({code:'CAPABILITY_REQUIRED'});
  await sql`update memberships set role='owner' where id=${a.membershipId}`;
  await sql`update memberships set state='revoked',revoked_at=now() where id=${a.membershipId}`;
  await expect(app.updateSlug(ctx,input)).rejects.toMatchObject({code:'NOT_FOUND'});
  await sql`update memberships set state='active',revoked_at=null where id=${a.membershipId}`;
  const races=await Promise.allSettled([app.updateSlug(context(a),{slug:'race-address',expectedSlugRevision:3}),second.updateSlug(context(b),{slug:'race-address',expectedSlugRevision:1})]);
  expect(races.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(races.filter(r=>r.status==='rejected')).toHaveLength(1);
  expect(await sql`select count(*)::int n from workspace_slug_aliases where slug='race-address'`).toEqual([{n:1}]);
  expect(await sql`select count(*)::int n from audit_events where action='slug_changed'`).toEqual([{n:3}]);
  expect(await sql`select count(*)::int n from command_idempotency where command='workspace.slug.update'`).toEqual([{n:3}]);
  expect(await sql`select count(*)::int n from outbox_events where type='workspace.slug_changed'`).toEqual([{n:3}]);
 }finally{await other?.close();await db?.close();await target.drop();}
});
it('rolls back aliases, workspace head, receipt and audit when a late database write fails',async()=>{
 const target=await createThrowawayDatabase('slug_rollback');let db:Database|undefined;
 try{await runMigrations(target.url,{requireLoopback:true});db=createDatabase(target.url,{requireLoopback:true});const a=await owner(db),sql=db.sql;
  await sql.unsafe(`create function fail_slug_receipt() returns trigger language plpgsql as $$ begin if NEW.command='workspace.slug.update' then raise exception 'synthetic late receipt failure'; end if; return NEW; end $$`);
  await sql.unsafe(`create trigger fail_slug_receipt before insert on command_idempotency for each row execute function fail_slug_receipt()`);
  await expect(createWorkspaceSlugApplication(db).updateSlug(context(a),{slug:'rollback-address',expectedSlugRevision:1})).rejects.toThrow();
  expect(await sql`select slug,slug_revision,change_seq::text seq from workspaces where id=${a.workspaceId}`).toEqual([{slug:null,slug_revision:1,seq:'0'}]);
  for(const table of ['workspace_slug_aliases','audit_events','outbox_events','command_idempotency'])expect(await sql.unsafe(`select count(*)::int n from ${table}`)).toEqual([{n:0}]);
 }finally{await db?.close();await target.drop();}
});
