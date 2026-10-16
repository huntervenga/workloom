import {idSchema,recurrenceHashSchema} from '@workloom/contracts';
import {PgDialect} from 'drizzle-orm/pg-core';
import {describe,expect,it} from 'vitest';
import type {WorkloomExecutor} from '../client.js';
import {RECURRENCE_RELAY_PREDICATES,RELAY_HASH_PATTERN,RELAY_UUID_PATTERN,createRecurrenceOutboxRelay,parseRelayRow,relayLimit} from './outbox-relay.js';
const row={id:'abcdef00-0000-4000-8000-000000000001',workspaceId:'abcdef00-0000-4000-8000-000000000002',type:'recurrence.materialization_requested',schemaVersion:1,
 payload:{seriesId:'abcdef00-0000-4000-8000-000000000003',bindingId:'abcdef00-0000-4000-8000-000000000004',sourceManifestHash:'c'.repeat(64),authorizationRevision:2},occurredAt:new Date('2026-10-16T08:00:00.000Z')};
const withPayload=(patch:Record<string,unknown>)=>({...row,payload:{...row.payload,...patch}});
const uuidCorpus=[
 'abcdef00-0000-4000-8000-000000000001','ABCDEF00-0000-4000-8000-000000000001','abcdef00-0000-1000-B000-000000000001','abcdef00-0000-8000-a000-000000000001',
 '00000000-0000-0000-0000-000000000000','ffffffff-ffff-ffff-ffff-ffffffffffff','FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF','Ffffffff-ffff-ffff-ffff-ffffffffffff',
 '00000000-0000-0000-0000-000000000001','abcdef00-0000-0000-8000-000000000001','abcdef00-0000-9000-8000-000000000001','abcdef00-0000-4000-c000-000000000001',
 'abcdef00-0000-4000-8000-000000000001\n','{abcdef00-0000-4000-8000-000000000001}','abcdef0000004000800000000000000001','',
];
describe('recurrence outbox relay adapter',()=>{
 it('mirrors the zod UUID and hash regexes exactly, including nil/max literals and case',()=>{
  const uuid=new RegExp(RELAY_UUID_PATTERN),hash=new RegExp(RELAY_HASH_PATTERN);
  for(const value of uuidCorpus)expect([value,uuid.test(value)]).toEqual([value,idSchema.safeParse(value).success]);
  for(const value of ['c'.repeat(64),'C'.repeat(64),'c'.repeat(63),`${'c'.repeat(64)}\n`,'g'.repeat(64)])expect([value,hash.test(value)]).toEqual([value,recurrenceHashSchema.safeParse(value).success]);
 });
 it('parses exactly the subscribed v1 event with the outbox row ID as deterministic event ID',()=>{
  expect(parseRelayRow(row)).toEqual({eventId:row.id,workspaceId:row.workspaceId,type:row.type,schemaVersion:1,payload:row.payload,occurredAt:'2026-10-16T08:00:00.000Z'});
  expect(parseRelayRow({...row,id:'00000000-0000-0000-0000-000000000000'})?.eventId).toBe('00000000-0000-0000-0000-000000000000');
  expect(parseRelayRow(withPayload({authorizationRevision:Number.MAX_SAFE_INTEGER}))).not.toBeNull();
  expect(parseRelayRow(withPayload({seriesId:row.payload.seriesId.toUpperCase()}))?.payload.seriesId).toBe(row.payload.seriesId);
  expect(parseRelayRow({...row,occurredAt:new Date('9999-12-31T23:59:59.999Z')})).not.toBeNull();
 });
 it('fails closed exactly where the SQL predicate excludes rows',()=>{
  expect(parseRelayRow({...row,schemaVersion:2})).toBeNull();
  expect(parseRelayRow({...row,type:'meeting.created'})).toBeNull();
  expect(parseRelayRow({...row,id:'00000000-0000-0000-0000-000000000001'})).toBeNull();
  expect(parseRelayRow({...row,workspaceId:'abcdef00-0000-0000-8000-000000000002'})).toBeNull();
  expect(parseRelayRow({...row,occurredAt:new Date('+010000-01-01T00:00:00.000Z')})).toBeNull();
  expect(parseRelayRow({...row,occurredAt:new Date(Number.NaN)})).toBeNull();
  expect(parseRelayRow(withPayload({actorUserId:row.workspaceId}))).toBeNull();
  for(const authorizationRevision of [0,1.5,'2',Number.MAX_SAFE_INTEGER+1,null])expect(parseRelayRow(withPayload({authorizationRevision}))).toBeNull();
  expect(parseRelayRow(withPayload({sourceManifestHash:'C'.repeat(64)}))).toBeNull();
  expect(parseRelayRow(withPayload({bindingId:'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF'}))).toBeNull();
  for(const payload of [null,[],'x',7])expect(parseRelayRow({...row,payload:payload as unknown as Record<string,unknown>})).toBeNull();
 });
 it('bounds the batch to 1..100 with default 50 before opening any transaction',async()=>{
  expect(relayLimit(undefined)).toBe(50);expect(relayLimit(100)).toBe(100);
  for(const bad of [0,101,1.5,Number.NaN])expect(()=>relayLimit(bad)).toThrow(RangeError);
  const untouched={transaction:()=>{throw new Error('no transaction expected');}} as unknown as WorkloomExecutor;
  await expect(createRecurrenceOutboxRelay(untouched).relayBatch(async()=>({accepted:true,jobId:null}),101)).rejects.toThrow(RangeError);
 });
 it('scopes every selection to the exact pending type and version 1, never a global outbox namespace',()=>{
  const dialect=new PgDialect();
  const pending=dialect.sqlToQuery(RECURRENCE_RELAY_PREDICATES.subscribedPending);
  expect(pending.sql).toContain('"outbox_events"."dispatched_at" is null');
  expect(pending.sql).toContain('"outbox_events"."type" = $1');
  expect(pending.params).toEqual(['recurrence.materialization_requested']);
  const supported=dialect.sqlToQuery(RECURRENCE_RELAY_PREDICATES.supported);
  expect(supported.sql).toContain('"outbox_events"."schema_version" = $1');
  expect(supported.params[0]).toBe(1);
 });
 it('keeps the payload predicate NULL-safe and cast-safe for null/array/scalar payloads',()=>{
  const {sql:text}=new PgDialect().sqlToQuery(RECURRENCE_RELAY_PREDICATES.supported);
  expect(text.trimEnd().endsWith('is true)')).toBe(true);
  expect(text).toContain(`case when jsonb_typeof("outbox_events"."payload") = 'object' then`);
  expect(text).toContain(`jsonb_object_keys(case when jsonb_typeof("outbox_events"."payload") = 'object' then "outbox_events"."payload" else '{}'::jsonb end)`);
  expect(text).toContain(`case when jsonb_typeof("outbox_events"."payload"->'authorizationRevision') = 'number' then`);
  expect(text).toContain('between 1 and 9007199254740991');
  expect(text).toContain('extract(year from "outbox_events"."occurred_at" at time zone \'UTC\') between 1 and 9999');
  expect(text).not.toContain('~*');
 });
});
