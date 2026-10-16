import {createHmac} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {createPlanningCursorCodec} from '../planning/cursor.js';
import {createRecurrenceCursorCodec} from './cursor.js';
const secret='local-test-key-not-a-secret'.repeat(2);
const first={version:1 as const,workspaceId:'abcdef00-0000-4000-8000-000000000001',actorUserId:'abcdef00-0000-4000-8000-000000000002',permissionEpoch:'7',periodId:'abcdef00-0000-4000-8000-000000000003',manifestHash:'b'.repeat(64),afterSeriesId:null,afterOccurrenceKey:null};
const next={...first,afterSeriesId:'abcdef00-0000-4000-8000-000000000004',afterOccurrenceKey:'2026-10-19'};
const invalid=expect.objectContaining({code:'VALIDATION_FAILED'});
describe('recurrence signed materialization cursor',()=>{
 it('round-trips first and continuation anchors and binds the whole scope',()=>{
  const codec=createRecurrenceCursorCodec({secret});
  expect(codec.decode(codec.encode(first))).toEqual(first);
  expect(codec.decode(codec.encode(next))).toEqual(next);
 });
 it('rejects expiry, another key, tampering and a re-signed body without the purpose label',()=>{
  let now=1000;const codec=createRecurrenceCursorCodec({secret,ttlMs:100,now:()=>now});const token=codec.encode(next);
  expect(()=>createRecurrenceCursorCodec({secret:'different-local-test-key'.repeat(2),now:()=>now}).decode(token)).toThrow(invalid);
  const [body,signature]=token.split('.') as [string,string];
  expect(()=>codec.decode(`${body}a.${signature}`)).toThrow(invalid);
  const forged=Buffer.from(JSON.stringify({...JSON.parse(Buffer.from(body,'base64url').toString('utf8')),periodId:'abcdef00-0000-4000-8000-000000000009'}),'utf8').toString('base64url');
  expect(()=>codec.decode(`${forged}.${signature}`)).toThrow(invalid);
  const plain=createHmac('sha256',Buffer.from(secret,'utf8')).update(body,'utf8').digest('base64url');
  expect(()=>codec.decode(`${body}.${plain}`)).toThrow(invalid);
  now=1100;expect(()=>codec.decode(token)).toThrow(invalid);
 });
 it('never accepts a planning list cursor signed with the same secret',()=>{
  const planning=createPlanningCursorCodec({secret}).encode({version:1,workspaceId:first.workspaceId,actorUserId:first.actorUserId,permissionEpoch:'7',queryHash:'a'.repeat(64),afterId:first.periodId});
  expect(()=>createRecurrenceCursorCodec({secret}).decode(planning)).toThrow(invalid);
 });
 it('refuses half anchors, invalid dates, noncanonical IDs, bad hashes and invalid options',()=>{
  const codec=createRecurrenceCursorCodec();
  expect(()=>codec.encode({...first,afterSeriesId:next.afterSeriesId})).toThrow(TypeError);
  expect(()=>codec.encode({...next,afterOccurrenceKey:'2026-02-30'})).toThrow(TypeError);
  expect(()=>codec.encode({...next,afterOccurrenceKey:'1999-12-31'})).toThrow(TypeError);
  expect(()=>codec.encode({...first,periodId:first.periodId.toUpperCase()})).toThrow(TypeError);
  expect(()=>codec.encode({...first,manifestHash:'B'.repeat(64)})).toThrow(TypeError);
  expect(()=>codec.encode({...first,permissionEpoch:'-1'})).toThrow(TypeError);
  expect(()=>codec.decode('')).toThrow(invalid);
  expect(()=>codec.decode('a.b.c')).toThrow(invalid);
  expect(()=>createRecurrenceCursorCodec({secret:'tiny'})).toThrow(TypeError);
  expect(()=>createRecurrenceCursorCodec({ttlMs:0})).toThrow(TypeError);
 });
});
