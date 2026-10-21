import {describe,it,expect} from 'vitest';
import {acceptTeamInvitationInputSchema,issueTeamInvitationInputSchema,updateTeamMembershipInputSchema,teamInvitationSecretPreimage} from './team.js';
const id='a0000000-0000-4000-8000-000000000001';
describe('team capability contract',()=>{
 it('bounds lifetime and excludes owner grants, identity selectors and plaintext on issuance',()=>{const input={id,role:'member',hashVersion:1,secretHash:'a'.repeat(64),expiresInSeconds:604800};expect(issueTeamInvitationInputSchema.safeParse(input).success).toBe(true);for(const patch of [{role:'owner'},{expiresInSeconds:604801},{expiresInSeconds:59},{secret:'x'.repeat(43)},{createdByUserId:id},{workspaceId:id},{secretHash:'A'.repeat(64)}])expect(issueTeamInvitationInputSchema.safeParse({...input,...patch}).success).toBe(false);});
 it('binds the preimage to version, UUID and all32 secret bytes consistently across UUID casing',()=>{const secret=new Uint8Array(32).fill(17),bytes=teamInvitationSecretPreimage(id,secret);expect(bytes).toEqual(Uint8Array.from(`workloom-invite:v1:${id}:${'11'.repeat(32)}`,character=>character.charCodeAt(0)));expect(teamInvitationSecretPreimage(id.toUpperCase(),secret)).toEqual(bytes);expect(bytes).not.toEqual(teamInvitationSecretPreimage(id.replace(/1$/,'2'),secret));expect(()=>teamInvitationSecretPreimage(id,new Uint8Array(31))).toThrow();});
 it('accepts only ID and secret, and forbids role promotion to owner in membership updates',()=>{expect(acceptTeamInvitationInputSchema.safeParse({invitationId:id,secret:'A'.repeat(43)}).success).toBe(true);expect(acceptTeamInvitationInputSchema.safeParse({invitationId:id,secret:'A'.repeat(43),role:'admin'}).success).toBe(false);expect(updateTeamMembershipInputSchema.safeParse({expectedRevision:1,role:'owner',state:'active'}).success).toBe(false);});
 it('normalizes addressed mailboxes without aliases and does not inject recipient into legacy parsed inputs',()=>{
  const legacy={id,role:'member',hashVersion:1,secretHash:'a'.repeat(64),expiresInSeconds:60};
  expect(issueTeamInvitationInputSchema.parse(legacy)).toEqual(legacy);
  expect(issueTeamInvitationInputSchema.parse({...legacy,recipient:{firstName:' Ada ',lastName:' Lovelace ',email:' Ada+Work@Example.COM '}}).recipient).toEqual({firstName:'Ada',lastName:'Lovelace',email:'ada+work@example.com'});
  expect(issueTeamInvitationInputSchema.safeParse({...legacy,recipient:{firstName:'Ada',lastName:'',email:'ada@example.com'}}).success).toBe(true);
  expect(issueTeamInvitationInputSchema.safeParse({...legacy,recipient:{firstName:'A'.repeat(100),lastName:'B'.repeat(100),email:'ada@example.com'}}).success).toBe(false);
  for(const [firstName,lastName] of [['A\0da','Lovelace'],['Ada','Love\nlace'],['\tAda','Lovelace']])expect(issueTeamInvitationInputSchema.safeParse({...legacy,recipient:{firstName,lastName,email:'ada@example.com'}}).success).toBe(false);
  for(const recipient of [{firstName:'',lastName:'L',email:'a@example.com'},{firstName:'A',lastName:'L',email:'invalid'},{firstName:'A',lastName:'L',email:'a@example.com',userId:id}])expect(issueTeamInvitationInputSchema.safeParse({...legacy,recipient}).success).toBe(false);
 });
});
