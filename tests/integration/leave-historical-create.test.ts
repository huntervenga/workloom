// Historical absence creation uses only this file's owned PostgreSQL child.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, createLeaveApplication, createSharedAuthStore, runMigrations, type Database } from '@workloom/db';
import type { CommandContext, LeaveApplication } from '@workloom/domain';
import { createThrowawayDatabase, type ThrowawayDatabase } from './support/test-database.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';
import { databaseSnapshot } from './support/p1b.js';

requireTestDatabaseUrl();

const add = (date: string, days: number) => new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
const must = <T>(value: T | null | undefined): T => { if (value === null || value === undefined) throw Error('Missing synthetic fixture.'); return value; };
const monday = (date: string) => must(Array.from({ length: 7 }, (_, i) => add(date, i)).find(day => new Date(day + 'T00:00:00Z').getUTCDay() === 1));

describe('manager historical absence creation', () => {
  let target: ThrowawayDatabase | undefined, db: Database, leave: LeaveApplication, today: string, year: number;

  beforeAll(async () => {
    target = await createThrowawayDatabase('leave_historical_create');
    await runMigrations(target.url, { requireLoopback: true });
    db = createDatabase(target.url, { requireLoopback: true });
    leave = createLeaveApplication(db);
    const [clock] = await db.sql`select (clock_timestamp() at time zone 'UTC')::date::text as today`;
    today = String(clock?.today);
    year = Number(today.slice(0, 4));
  }, 60000);

  afterAll(async () => {
    await db?.close();
    await target?.drop();
  }, 30000);


  async function fixture(withPaid = true) {
    const identity=await createSharedAuthStore(db).provisionIdentity({issuer:'https://auth.example.test',subject:randomUUID(),displayName:'Synthetic history owner',workspaceName:'Synthetic history',timezone:'UTC'}),workspaceId=identity.workspaceId,userId=identity.user.id;
    const [m]=await db.sql`select id from memberships where workspace_id=${workspaceId} and user_id=${userId}`;const membershipId=String(m?.id),ctx=(key=randomUUID()):CommandContext=>({workspaceId,actor:{userId,kind:'real',displayName:'Synthetic owner'},source:'web',requestId:randomUUID(),idempotencyKey:key});
    const settings=await leave.template(ctx(),{expectedRevision:0,effectiveYear:year-4,includeCompanyHolidays:false}),policy=must(settings.policyVersions[0]),vacation=must(policy.types.find(t=>t.consumesBalance&&t.carryover.mode==='unlimited')),pause=must(policy.types.find(t=>t.pausesAccrual&&!t.consumesBalance));
    const hire=add(today,-600);await leave.profile(ctx(),membershipId,{expectedRevision:0,employmentStart:hire,accountingStart:hire,employmentEnd:null,timezone:'UTC',openingBalances:[],schedulePeriods:[{effectiveFrom:hire,weeklyMinutes:[480,480,480,480,480,0,0]}],reason:''});
    if(withPaid){const startDate=monday(add(today,-590)),input={source:{sha256:'b'.repeat(64),sheet:'History'},rows:[{membershipId,typeId:vacation.id,startDate,endDate:add(startDate,25),sourceRows:[2],note:'Pinned paid history'}],reason:'Synthetic import'},ic={...ctx(),source:'import' as const},preview=await leave.previewHistory(ic,input);await leave.importHistory({...ctx(),source:'import'},{...input,expectedSourceVersion:preview.sourceVersion});}
    const startDate=monday(add(today,-500)),endDate=add(startDate,334);return {workspaceId,membershipId,ctx,vacation,pause,startDate,endDate};
  }
  const candidate=(f:Awaited<ReturnType<typeof fixture>>)=>({membershipId:f.membershipId,typeId:f.pause.id,startDate:f.startDate,endDate:f.endDate,note:'Long historical unpaid interval',reason:''});
  async function pinned(f:Awaited<ReturnType<typeof fixture>>){return {settings:await db.sql`select * from leave_settings where workspace_id=${f.workspaceId}`,profiles:await db.sql`select * from leave_profiles where workspace_id=${f.workspaceId}`,versions:await db.sql`select * from leave_request_versions where workspace_id=${f.workspaceId} and revision=1 order by request_id`,ledger:await db.sql`select * from leave_charge_ledger where workspace_id=${f.workspaceId} order by id`,adjustments:await db.sql`select * from leave_adjustments where workspace_id=${f.workspaceId}`};}
  it('reviews a 335-calendar-day unpaid history without reason/read writes, then records it with reason despite paid-pool debt',async()=>{
    const f=await fixture(),body=candidate(f),before=await databaseSnapshot(db.sql),preview=await leave.preview(f.ctx(),{...body,approveNegative:false});expect(await databaseSnapshot(db.sql)).toEqual(before);
    expect((Date.parse(f.endDate)-Date.parse(f.startDate))/86400000+1).toBe(335);expect(preview.chargedDays.length).toBe(240);expect(preview.totalMicrodays).toBe(0);expect(preview.unavailableMinutes).toBe(240*480);expect(must(preview.balancesBefore.find(b=>b.typeId===f.vacation.id)).availableMicrodays).toBeGreaterThanOrEqual(0);expect(must(preview.balancesAfter.find(b=>b.typeId===f.vacation.id)).availableMicrodays).toBeLessThan(0);expect(preview.deficits.length).toBeGreaterThan(0);
    for(const reason of ['','   '])await expect(leave.create(f.ctx(),{...body,reason,expectedSourceVersion:preview.sourceVersion})).rejects.toMatchObject({code:'DOMAIN_VALIDATION_FAILED'});expect(await databaseSnapshot(db.sql)).toEqual(before);
    const old=pinned(f),facts=await old,context=f.ctx(),input={...body,reason:'Record actual historical sabbatical',expectedSourceVersion:preview.sourceVersion},saved=await leave.create(context,input);expect(saved.status).toBe('approved');expect(saved.negativeApproved).toBe(false);expect(saved.chargedDays).toEqual(preview.chargedDays);
    const after=await pinned(f);expect(after.settings).toEqual(facts.settings);expect(after.profiles).toEqual(facts.profiles);expect(after.adjustments).toEqual(facts.adjustments);for(const row of facts.versions)expect(after.versions).toContainEqual(row);for(const row of facts.ledger)expect(after.ledger).toContainEqual(row);
    const [audit]=await db.sql`select reason,diff from audit_events where workspace_id=${f.workspaceId} and entity_type='leave_request' and entity_id=${saved.id} order by recorded_at desc,event_ordinal desc limit 1`;expect(audit?.reason).toBe(input.reason);expect(audit?.diff.historicalAbsenceRecording).toBe(true);expect(audit?.diff.after.endDate).toBe(f.endDate);
    const snapshot=await databaseSnapshot(db.sql);expect(await leave.create(context,input)).toEqual(saved);expect(await databaseSnapshot(db.sql)).toEqual(snapshot);
    const date=monday(add(today,7)),pending=await leave.create(f.ctx(),{membershipId:f.membershipId,typeId:f.vacation.id,startDate:date,endDate:date,note:'',reason:''});expect(pending.status).toBe('pending');const approved=await leave.decide(f.ctx(),pending.id,{expectedRevision:1,decision:'approve',reason:'',approveNegative:false});expect(approved.status).toBe('approved');expect(approved.negativeApproved).toBe(false);
  });
  it('uses the same bounded historical admission for bulk and existing fully-past pending approval',async()=>{
    for(const mode of ['bulk','pending'] as const){const f=await fixture(),body=candidate(f);let saved;
      if(mode==='bulk'){const input={membershipIds:[f.membershipId],typeId:f.pause.id,startDate:f.startDate,endDate:f.endDate,note:'Bulk historical interval',reason:'',approveNegative:false},p=await leave.previewBulk(f.ctx(),input),before=await databaseSnapshot(db.sql);await expect(leave.bulk(f.ctx(),{...input,expectedSourceVersion:p.sourceVersion})).rejects.toMatchObject({code:'DOMAIN_VALIDATION_FAILED'});expect(await databaseSnapshot(db.sql)).toEqual(before);saved=must((await leave.bulk(f.ctx(),{...input,reason:'Record confirmed historical absence',approveNegative:true,expectedSourceVersion:p.sourceVersion}))[0]);}
      else{const date=monday(add(today,7)),pending=await leave.create(f.ctx(),{...body,startDate:date,endDate:date}),past=await leave.update(f.ctx(),pending.id,{expectedRevision:1,startDate:f.startDate,endDate:f.endDate,note:body.note,reason:'Correct pending request to actual past dates'});expect(past.status).toBe('pending');const p=await leave.preview(f.ctx(),{...body,excludeRequestId:past.id,approveNegative:false}),before=await databaseSnapshot(db.sql);await expect(leave.decide(f.ctx(),past.id,{expectedRevision:2,expectedSourceVersion:p.sourceVersion,decision:'approve',reason:' ',approveNegative:false})).rejects.toMatchObject({code:'DOMAIN_VALIDATION_FAILED'});expect(await databaseSnapshot(db.sql)).toEqual(before);saved=await leave.decide(f.ctx(),past.id,{expectedRevision:2,expectedSourceVersion:p.sourceVersion,decision:'approve',reason:'Confirm actual past absence',approveNegative:true});}
      expect(saved.status).toBe('approved');expect(saved.negativeApproved).toBe(false);const [audit]=await db.sql`select diff from audit_events where workspace_id=${f.workspaceId} and entity_type='leave_request' and entity_id=${saved.id} order by recorded_at desc,event_ordinal desc limit 1`;expect(audit?.diff.historicalAbsenceRecording).toBe(true);
    }
  });
  it('records manager overlap/out-of-profile/current history without credits while retaining employee and source guards',async()=>{
    const f=await fixture(false),startDate=monday(add(today,-580)),endDate=add(startDate,32),input={membershipId:f.membershipId,typeId:f.vacation.id,startDate,endDate,note:'Paid history',reason:'Record actual paid leave'},preview=await leave.preview(f.ctx(),{...input,reason:'',approveNegative:false});expect(preview.deficits.length).toBeGreaterThan(0);const saved=await leave.create(f.ctx(),{...input,expectedSourceVersion:preview.sourceVersion});expect(saved.status).toBe('approved');expect(saved.negativeApproved).toBe(false);
    const priorTaken=must((await leave.overview(f.ctx())).balances.find(b=>b.typeId===f.vacation.id)).takenMicrodays,duplicate=await leave.create(f.ctx(),input);expect(duplicate.id).not.toBe(saved.id);expect(must((await leave.overview(f.ctx())).balances.find(b=>b.typeId===f.vacation.id)).takenMicrodays).toBe(priorTaken);const before=await databaseSnapshot(db.sql),outside=await leave.preview(f.ctx(),{...input,startDate:add(today,-601),reason:'',approveNegative:false});expect(outside.warnings?.warnings.some(w=>w.code==='OUTSIDE_EMPLOYMENT')).toBe(true);expect(await databaseSnapshot(db.sql)).toEqual(before);
    const current=await leave.create(f.ctx(),{membershipId:f.membershipId,typeId:f.vacation.id,startDate:monday(add(today,-60)),endDate:today,note:'Current pending',reason:'Current-day request'});expect(current.status).toBe('pending');const approvedCurrent=await leave.decide(f.ctx(),current.id,{expectedRevision:1,decision:'approve',reason:'Reasoned current absence',approveNegative:false});expect(approvedCurrent.status).toBe('approved');expect(approvedCurrent.negativeApproved).toBe(false);
    const body=candidate(f),p=await leave.preview(f.ctx(),{...body,approveNegative:false});await leave.update(f.ctx(),saved.id,{expectedRevision:1,startDate,endDate,note:'Concurrent note',reason:'Correct history note'});const afterEdit=await databaseSnapshot(db.sql);await expect(leave.create(f.ctx(),{...body,reason:'Stale source',expectedSourceVersion:p.sourceVersion})).rejects.toMatchObject({code:'PREVIEW_STALE'});expect(await databaseSnapshot(db.sql)).toEqual(afterEdit);
    await db.sql`update memberships set role='member' where id=${f.membershipId}`;const employeeBefore=await databaseSnapshot(db.sql);await expect(leave.preview(f.ctx(),{...body,approveNegative:false})).rejects.toMatchObject({code:'DOMAIN_VALIDATION_FAILED'});await expect(leave.create(f.ctx(),{...body,reason:'Employee cannot admit history'})).rejects.toMatchObject({code:'DOMAIN_VALIDATION_FAILED'});expect(await databaseSnapshot(db.sql)).toEqual(employeeBefore);
  });
});
