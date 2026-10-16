import {createHash} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {localMcpSecretPreimage} from '@workloom/contracts';
import {parseLocalMcpBearer} from './credentials.js';
const id='10000000-0000-4000-8000-000000000001',encoded='AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
describe('local MCP bearer format',()=>{
 it('matches the independent browser/server public vector',()=>{const bytes=localMcpSecretPreimage(id,Uint8Array.from({length:32},(_,i)=>i));expect(bytes.length).toBe(98);expect(createHash('sha256').update(bytes).digest('hex')).toBe('95ab16b90eaedb9f791d0a5e5f38fb8e551a58555e039771026539a5181356ac');expect(parseLocalMcpBearer(`wlm_local_v1_${id}.${encoded}`).secretHash).toBe('95ab16b90eaedb9f791d0a5e5f38fb8e551a58555e039771026539a5181356ac');});
 it.each([` wlm_local_v1_${id}.${encoded}`,`wlm_local_v1_${id}.${encoded}=`,`wlm_local_v1_${id}.${encoded.slice(0,-1)}9`,`wlm_local_v1_${id}.${encoded}.extra`,`wlm_local_v1_${id}.short`])('rejects noncanonical material without revealing it',token=>{expect(()=>parseLocalMcpBearer(token)).toThrow(expect.objectContaining({code:'UNAUTHENTICATED'}));});
});
