import {describe,it,expect} from 'vitest';
import {allowedLocalMcpScopes,assertLocalCredentialCurrent,assertLocalMcpScope} from './policy.js';
import type {LocalCredentialDto} from '@workloom/contracts';
const row:LocalCredentialDto={id:'10000000-0000-4000-8000-000000000001',workspaceId:'10000000-0000-4000-8000-000000000002',ownerUserId:'10000000-0000-4000-8000-000000000003',name:'local',hashVersion:1,scopes:['tasks.read','tasks.create'],revision:1,createdAt:'2026-10-16T06:00:00.000Z',expiresAt:'2026-10-16T07:00:00.000Z',revokedAt:null};
describe('local MCP current policy',()=>{
 it('phase A never grants writes even to owner',()=>{expect(allowedLocalMcpScopes('owner')).not.toContain('tasks.create');expect(()=>assertLocalMcpScope(row,'owner','create_task')).toThrow(expect.objectContaining({code:'CAPABILITY_REQUIRED'}));});
 it('requires both token scope and current role for phase B',()=>{expect(()=>assertLocalMcpScope(row,'viewer','create_task',true)).toThrow(expect.objectContaining({code:'CAPABILITY_REQUIRED'}));expect(()=>assertLocalMcpScope(row,'member','create_task',true)).not.toThrow();expect(()=>assertLocalMcpScope(row,'owner','get_project',true)).toThrow(expect.objectContaining({code:'CAPABILITY_REQUIRED'}));});
 it('expires exactly at server cutoff and rejects revoked token',()=>{expect(()=>assertLocalCredentialCurrent(row,new Date(row.expiresAt))).toThrow(expect.objectContaining({code:'UNAUTHENTICATED'}));expect(()=>assertLocalCredentialCurrent({...row,revokedAt:row.createdAt},new Date(row.createdAt))).toThrow(expect.objectContaining({code:'UNAUTHENTICATED'}));});
});
