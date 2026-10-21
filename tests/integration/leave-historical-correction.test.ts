// Historical absence corrections use only this file's owned PostgreSQL child.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, createLeaveApplication, createSharedAuthStore, runMigrations, type Database } from '@workloom/db';
import type { CommandContext, LeaveApplication } from '@workloom/domain';
import { createThrowawayDatabase, type ThrowawayDatabase } from './support/test-database.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';
import { databaseSnapshot } from './support/p1b.js';

requireTestDatabaseUrl();

const add = (date: string, days: number) => new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
const must = <T>(value: T | null | undefined): T => { if (value === null || value === undefined) throw Error('Missing synthetic correction fixture.'); return value; };
const monday = (date: string) => must(Array.from({ length: 7 }, (_, i) => add(date, i)).find(day => new Date(day + 'T00:00:00Z').getUTCDay() === 1));

describe('reasoned historical absence corrections', () => {
  let target: ThrowawayDatabase | undefined, db: Database, leave: LeaveApplication, today: string, year: number;

  beforeAll(async () => {
    target = await createThrowawayDatabase('leave_historical_absence');
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

  async function fixture(days = 10, unpaid = false) {
    const identity = await createSharedAuthStore(db).provisionIdentity({ issuer:'https://auth.example.test',subject:randomUUID(),displayName:'Synthetic correction owner',workspaceName:'Synthetic correction',timezone:'UTC' });
    const workspaceId=identity.workspaceId,userId=identity.user.id;
    const [member]=await db.sql`select id from memberships where workspace_id=${workspaceId} and user_id=${userId}`;const membershipId=String(member?.id);
    const ctx=(key=randomUUID()):CommandContext=>({workspaceId,actor:{userId,kind:'real',displayName:'Synthetic owner'},source:'import',requestId:randomUUID(),idempotencyKey:key});
    const settings=await leave.template(ctx(),{expectedRevision:0,effectiveYear:year-4,includeCompanyHolidays:false}),policy=must(settings.policyVersions[0]),vacation=must(policy.types.find(type=>type.consumesBalance&&type.carryover.mode==='unlimited')),pause=must(policy.types.find(type=>type.pausesAccrual&&!type.consumesBalance));
    await leave.profile(ctx(),membershipId,{expectedRevision:0,employmentStart:unpaid?add(today,-100):`${year-2}-05-01`,accountingStart:unpaid?add(today,-100):`${year-2}-05-01`,employmentEnd:null,timezone:'UTC',openingBalances:[],schedulePeriods:[{effectiveFrom:unpaid?add(today,-100):`${year-2}-05-01`,weeklyMinutes:[480,480,480,480,480,0,0]}],reason:''});
    const startDate=unpaid?monday(add(today,-80)):monday(`${year-2}-07-01`),endDate=add(startDate,Math.floor((days-1)/5)*7+(days-1)%5),typeId=unpaid?pause.id:vacation.id;
    const rows=[{membershipId,typeId,startDate,endDate,sourceRows:[2],note:'Pinned history'}];
    if(unpaid){const paidStart=monday(add(today,-95));rows.push({membershipId,typeId:vacation.id,startDate:paidStart,endDate:add(paidStart,4),sourceRows:[3],note:'Historical paid charge'});}
    const input={source:{sha256:'c'.repeat(64),sheet:'Absences'},rows,reason:'Synthetic approved history'},preview=await leave.previewHistory(ctx(),input),requests=await leave.importHistory(ctx(),{...input,expectedSourceVersion:preview.sourceVersion});
    return {workspaceId,membershipId,ctx,vacation,pause,request:must(requests[0]),settings};
  }
  async function review(f:Awaited<ReturnType<typeof fixture>>,endDate:string){return leave.preview(f.ctx(),{membershipId:f.membershipId,typeId:f.request.typeId,excludeRequestId:f.request.id,startDate:f.request.startDate,endDate,note:f.request.note,reason:'Correct actual historical dates',approveNegative:false});}
  async function oldFacts(f:Awaited<ReturnType<typeof fixture>>){return {versions:await db.sql`select * from leave_request_versions where workspace_id=${f.workspaceId} and request_id=${f.request.id} and revision=1`,ledger:await db.sql`select * from leave_charge_ledger where workspace_id=${f.workspaceId} and request_id=${f.request.id} and request_revision=1 order by date`,settings:await db.sql`select * from leave_settings where workspace_id=${f.workspaceId}`,profiles:await db.sql`select * from leave_profiles where workspace_id=${f.workspaceId}`,adjustments:await db.sql`select * from leave_adjustments where workspace_id=${f.workspaceId}`};}
  it('records past/current/existing-future paid debt as advisory while preserving pinned facts, provenance and exact replay',async()=>{
    for(const mode of ['past','current','future'] as const){
      const f=await fixture(mode==='current'?60:10);
      if(mode==='future'){
        const startDate=monday(add(today,7));let lastSafeEnd:string|null=null,sawDeficit=false;
        // Reserve the largest ordinarily valid future interval, independent of today's month.
        for(let count=1;count<=100;count++){const endDate=add(startDate,Math.floor((count-1)/5)*7+(count-1)%5),candidate=await leave.preview(f.ctx(),{membershipId:f.membershipId,typeId:f.vacation.id,startDate,endDate,note:'Existing reservation',reason:'',approveNegative:false});if(candidate.deficits.length){sawDeficit=true;break;}lastSafeEnd=endDate;}
        expect(sawDeficit).toBe(true);expect(lastSafeEnd).not.toBeNull();await leave.bulk(f.ctx(),{membershipIds:[f.membershipId],typeId:f.vacation.id,startDate,endDate:must(lastSafeEnd),note:'Existing reservation',reason:'',approveNegative:false});
      }
      const endDate=add(f.request.endDate,7),preview=await review(f,endDate);expect(preview.deficits.length).toBeGreaterThan(0);
      if(mode==='past')expect(preview.deficits.some(d=>d.date<today)).toBe(true);
      if(mode==='current')expect(must(preview.balancesAfter.find(b=>b.typeId===f.vacation.id)).availableMicrodays).toBeLessThan(0);
      if(mode==='future')expect(preview.deficits.some(d=>d.date>today)).toBe(true);
      const facts=await oldFacts(f),[before]=await db.sql`select snapshot from leave_requests where id=${f.request.id}`;
      const input={expectedRevision:1,expectedSourceVersion:preview.sourceVersion,startDate:f.request.startDate,endDate,note:f.request.note,reason:'Correct actual historical dates'},context=f.ctx(),saved=await leave.update(context,f.request.id,input);
      expect(saved.revision).toBe(2);expect(saved.negativeApproved).toBe(false);expect(saved.chargedDays.filter(d=>d.date<=f.request.endDate)).toEqual(f.request.chargedDays);expect(saved.chargedDays.filter(d=>d.date>f.request.endDate)).toEqual(preview.chargedDays.filter(d=>d.date>f.request.endDate));expect(await oldFacts(f)).toEqual(facts);
      const [after]=await db.sql`select snapshot from leave_requests where id=${f.request.id}`;expect(after?.snapshot.historicalImport).toEqual(before?.snapshot.historicalImport);
      const [audit]=await db.sql`select reason,diff from audit_events where workspace_id=${f.workspaceId} and entity_type='leave_request' order by recorded_at desc,event_ordinal desc limit 1`;expect(audit?.reason).toBe(input.reason);expect(audit?.diff.historicalAbsenceCorrection).toBe(true);expect(audit?.diff.before.startDate).toBe(f.request.startDate);expect(audit?.diff.after.endDate).toBe(endDate);
      const snapshot=await databaseSnapshot(db.sql);expect(await leave.update(context,f.request.id,input)).toEqual(saved);expect(await databaseSnapshot(db.sql)).toEqual(snapshot);
      if(mode==='current'){const date=monday(add(today,7)),pending=await leave.create(f.ctx(),{membershipId:f.membershipId,typeId:f.vacation.id,startDate:date,endDate:date,note:'',reason:''}),beforeApproval=await databaseSnapshot(db.sql);await expect(leave.decide(f.ctx(),pending.id,{expectedRevision:1,decision:'approve',reason:'',approveNegative:false})).rejects.toMatchObject({code:'DOMAIN_VALIDATION_FAILED'});expect(await databaseSnapshot(db.sql)).toEqual(beforeApproval);}
    }
  });
  it('corrects a fully past unpaid pause even when it worsens paid-pool debt',async()=>{
    const f=await fixture(1,true),endDate=add(today,-1),preview=await review(f,endDate),beforeBalance=must(preview.balancesBefore.find(b=>b.typeId===f.vacation.id)),afterBalance=must(preview.balancesAfter.find(b=>b.typeId===f.vacation.id));
    expect(beforeBalance.availableMicrodays).toBeGreaterThanOrEqual(0);expect(afterBalance.availableMicrodays).toBeLessThan(beforeBalance.availableMicrodays);expect(afterBalance.availableMicrodays).toBeLessThan(0);expect(preview.deficits).toHaveLength(1);expect(preview.deficits[0]?.date).toBe(today);
    const facts=await oldFacts(f),saved=await leave.update(f.ctx(),f.request.id,{expectedRevision:1,expectedSourceVersion:preview.sourceVersion,startDate:f.request.startDate,endDate,note:f.request.note,reason:'Correct payroll unpaid interval'});expect(saved.pausesAccrual).toBe(true);expect(saved.negativeApproved).toBe(false);expect(await oldFacts(f)).toEqual(facts);
  });
  it('keeps strict today/future, pending, whitespace reason, overlap, revision and source checks',async()=>{
    const f=await fixture(60),original=await databaseSnapshot(db.sql),base={expectedRevision:1,startDate:f.request.startDate,note:f.request.note,reason:'Correct dates'};
    for(const endDate of [today,add(today,7)])await expect(leave.update(f.ctx(),f.request.id,{...base,endDate})).rejects.toMatchObject({code:'DOMAIN_VALIDATION_FAILED'});
    await expect(leave.update(f.ctx(),f.request.id,{...base,endDate:add(f.request.endDate,7),reason:'   '})).rejects.toMatchObject({code:'DOMAIN_VALIDATION_FAILED'});
    await expect(leave.update(f.ctx(),f.request.id,{...base,endDate:add(f.request.endDate,7),expectedRevision:4})).rejects.toMatchObject({code:'REVISION_CONFLICT'});expect(await databaseSnapshot(db.sql)).toEqual(original);
    const preview=await review(f,add(f.request.endDate,7));await leave.update(f.ctx(),f.request.id,{...base,endDate:add(f.request.endDate,7)});const fresh=await databaseSnapshot(db.sql);await expect(leave.update(f.ctx(),f.request.id,{...base,expectedRevision:2,expectedSourceVersion:preview.sourceVersion,endDate:add(f.request.endDate,14)})).rejects.toMatchObject({code:'PREVIEW_STALE'});expect(await databaseSnapshot(db.sql)).toEqual(fresh);
    const extraStart=add(f.request.endDate,21),input={source:{sha256:'d'.repeat(64),sheet:'Absences'},rows:[{membershipId:f.membershipId,typeId:f.vacation.id,startDate:extraStart,endDate:add(extraStart,2),sourceRows:[8],note:'Other pinned absence'}],reason:'Synthetic history'},p=await leave.previewHistory(f.ctx(),input);await leave.importHistory(f.ctx(),{...input,expectedSourceVersion:p.sourceVersion});const beforeOverlap=await databaseSnapshot(db.sql);await expect(leave.update(f.ctx(),f.request.id,{...base,expectedRevision:2,endDate:add(extraStart,2)})).rejects.toMatchObject({code:'DOMAIN_VALIDATION_FAILED'});expect(await databaseSnapshot(db.sql)).toEqual(beforeOverlap);
    const pendingStart=monday(add(today,14)),pending=await leave.create(f.ctx(),{membershipId:f.membershipId,typeId:f.vacation.id,startDate:pendingStart,endDate:pendingStart,note:'',reason:''}),beforePending=await databaseSnapshot(db.sql);await expect(leave.decide(f.ctx(),pending.id,{expectedRevision:1,decision:'approve',reason:'Historical reason is not an approval exemption',approveNegative:false})).rejects.toMatchObject({code:'DOMAIN_VALIDATION_FAILED'});expect(await databaseSnapshot(db.sql)).toEqual(beforePending);
  });
});
