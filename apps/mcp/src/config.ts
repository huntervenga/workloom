/** Process-only secrets stay out of command line arguments, logs and public config. */
export interface McpConfig {readonly apiUrl:string;readonly token:string;readonly origin:string}
export class McpConfigError extends Error {override readonly name='McpConfigError';constructor(){super('Invalid local MCP configuration. Require APP_ENV=local, a canonical credential, and an HTTP loopback API URL without proxy or hosted configuration.');}}
type Env=Readonly<Record<string,string|undefined>>;
export function loadMcpConfig(env:Env=process.env):McpConfig {
 const hosted=Object.entries(env).some(([key,value])=>value!==undefined&&value!==''&&(/^(RAILWAY_|VERCEL|RENDER_|FLY_APP_NAME|K_SERVICE|DYNO)/.test(key)));
 if(env.APP_ENV!=='local'||hosted||env.NODE_USE_ENV_PROXY==='1'||env.NODE_USE_ENV_PROXY==='true'||/--use-env-proxy/.test(env.NODE_OPTIONS??''))throw new McpConfigError();
 const token=env.WORKLOOM_MCP_TOKEN??'';
 const match=/^wlm_local_v1_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/.exec(token);
 if(match===null||Buffer.from(match[2]??'','base64url').length!==32||Buffer.from(match[2]??'','base64url').toString('base64url')!==match[2])throw new McpConfigError();
 let url:URL;try{url=new URL(env.WORKLOOM_MCP_API_URL??'http://127.0.0.1:4310/');}catch{throw new McpConfigError();}
 if(url.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(url.hostname)||url.username!==''||url.password!==''||url.search!==''||url.hash!==''||url.pathname!=='/')throw new McpConfigError();
 return {apiUrl:url.href,origin:url.origin,token};
}
