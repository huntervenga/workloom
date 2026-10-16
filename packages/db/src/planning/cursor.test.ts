import {describe,expect,it} from 'vitest';
import {createPlanningCursorCodec} from './cursor.js';
const payload={version:1 as const,workspaceId:'abcdef00-0000-4000-8000-000000000001',actorUserId:'abcdef00-0000-4000-8000-000000000002',permissionEpoch:'0',queryHash:'a'.repeat(64),afterId:'extra:abcdef00-0000-4000-8000-000000000003:abcdef00-0000-4000-8000-000000000004'};
describe('planning signed pagination',()=>{
 it('supports pinned extra rows and rejects expiry, another process and payload tampering',()=>{
   let now=1000;const codec=createPlanningCursorCodec({secret:'local-test-key-not-a-secret'.repeat(2),ttlMs:100,now:()=>now});
   const token=codec.encode(payload);expect(codec.decode(token)).toEqual(payload);
   const other=createPlanningCursorCodec({secret:'different-local-test-key'.repeat(2),now:()=>now});
   expect(()=>other.decode(token)).toThrow(expect.objectContaining({code:'VALIDATION_FAILED'}));
   const [body,signature]=token.split('.');expect(()=>codec.decode(`${body}a.${signature}`)).toThrow(expect.objectContaining({code:'VALIDATION_FAILED'}));
   now=1100;expect(()=>codec.decode(token)).toThrow(expect.objectContaining({code:'VALIDATION_FAILED'}));
 });
 it('refuses noncanonical identities, unsafe anchors and invalid key/TTL options',()=>{
   const codec=createPlanningCursorCodec();
   expect(()=>codec.encode({...payload,workspaceId:payload.workspaceId.toUpperCase()})).toThrow(TypeError);
   expect(()=>codec.encode({...payload,afterId:'1;drop table tasks'})).toThrow(TypeError);
   expect(()=>createPlanningCursorCodec({secret:'tiny'})).toThrow(TypeError);
   expect(()=>createPlanningCursorCodec({ttlMs:0})).toThrow(TypeError);
 });
});
