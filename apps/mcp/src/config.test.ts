import {describe,it,expect} from 'vitest';
import {loadMcpConfig} from './config.js';
const token='wlm_local_v1_10000000-0000-4000-8000-000000000001.AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const env={APP_ENV:'local',WORKLOOM_MCP_TOKEN:token};
describe('local MCP process configuration',()=>{
 it('allows local mode independently of production build and never needs database credentials',()=>{expect(loadMcpConfig({...env,NODE_ENV:'production'})).toEqual({apiUrl:'http://127.0.0.1:4310/',origin:'http://127.0.0.1:4310',token});expect(loadMcpConfig({...env,WORKLOOM_MCP_API_URL:'http://[::1]:4310/'}).origin).toBe('http://[::1]:4310');});
 it.each([undefined,'development','staging','production'])('rejects APP_ENV=%s without echoing secrets',APP_ENV=>{expect(()=>loadMcpConfig({...env,APP_ENV})).toThrow('Invalid local MCP configuration');try{loadMcpConfig({...env,APP_ENV});}catch(e){expect(String(e)).not.toContain(token);}});
 it.each(['https://127.0.0.1:4310/','http://localhost:4310/','http://example.com/','http://u:p@127.0.0.1/','http://127.0.0.1/api','http://127.0.0.1/?x=1','http://127.0.0.1/#secret'])('rejects unsafe URL %s',url=>{expect(()=>loadMcpConfig({...env,WORKLOOM_MCP_API_URL:url})).toThrow();});
 it.each([{RAILWAY_PROJECT_ID:'synthetic'},{VERCEL:'1'},{RENDER_SERVICE_ID:'synthetic'},{NODE_USE_ENV_PROXY:'1'},{NODE_OPTIONS:'--use-env-proxy'}])('rejects hosted or proxy config %j',extra=>{expect(()=>loadMcpConfig({...env,...extra})).toThrow();});
 it.each([token+'=',token.replace('Hh8','Hh9'),token.replace('wlm_local_v1_','wlm_local_'),' '+token,token+'.x',token.replace('10000000','ABCDEF00')])('rejects noncanonical token variant',bad=>{expect(()=>loadMcpConfig({...env,WORKLOOM_MCP_TOKEN:bad})).toThrow();});
});
