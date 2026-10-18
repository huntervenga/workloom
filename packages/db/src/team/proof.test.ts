import {describe,it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {teamInvitationSecretPreimage} from '@workloom/contracts';
import {proveTeamInvitation} from './application.js';
import {membershipDto} from './repository.js';
const invitationId='a0000000-0000-4000-8000-000000000500';
describe('team bearer proof',()=>{it('matches browser SHA256 input and normalizes UUID case',()=>{const bytes=Buffer.alloc(32,17),proof=proveTeamInvitation({invitationId:invitationId.toUpperCase(),secret:bytes.toString('base64url')});expect(proof).toEqual({id:invitationId,secretHash:createHash('sha256').update(teamInvitationSecretPreimage(invitationId,bytes)).digest('hex')});});it('rejects noncanonical trailing base64 bits despite equal decoded bytes',()=>{const secret='A'.repeat(43);expect(Buffer.from(secret,'base64url')).toEqual(Buffer.from('A'.repeat(42)+'B','base64url'));expect(()=>proveTeamInvitation({invitationId,secret:'A'.repeat(42)+'B'})).toThrow();});});

describe('team membership projection', () => {
 it.each(['active', 'revoked'] as const)('preserves stable membership ID for %s admission when the actor decoration includes its own ID', state => {
  const membershipId='a0000000-0000-4000-8000-000000000501';
  const actor={id:'a0000000-0000-4000-8000-000000000502',displayName:'Synthetic member',avatarUrl:null};
  const at=new Date('2026-10-18T12:00:00.000Z');
  const row={id:membershipId,workspaceId:'a0000000-0000-4000-8000-000000000503',userId:actor.id,role:'member' as const,state,revision:3,revokedAt:state==='revoked'?at:null,createdAt:at,updatedAt:at};
  expect(membershipDto(row,actor)).toEqual({id:membershipId,workspaceId:row.workspaceId,userId:actor.id,displayName:actor.displayName,avatarUrl:null,role:'member',state,revision:3,revokedAt:row.revokedAt?.toISOString()??null});
 });
});
