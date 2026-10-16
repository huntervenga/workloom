import type {McpConfig} from './config.js';
export const MAX_RESPONSE_BYTES=2*1024*1024;
export class BridgeError extends Error {override readonly name='BridgeError';constructor(readonly code:string,readonly status:number|null=null){super('The local Workloom request could not be completed.');}}
const SAFE_CODES=new Set(['UNAUTHENTICATED','CAPABILITY_REQUIRED','NOT_FOUND','VALIDATION_FAILED','DOMAIN_VALIDATION_FAILED','REVISION_CONFLICT','IDEMPOTENCY_KEY_REUSED','FIELD_LOCKED','PERIOD_CLOSED','DEPENDENCY_CYCLE','MATERIALIZATION_REQUIRED','TEMPORARILY_UNAVAILABLE','RATE_LIMITED']);
/** Fixed bridge paths only; caller arguments can never change the origin or headers. */
export function createBridgeTransport(config:McpConfig,fetcher:typeof fetch=fetch) {
 const pending=new Set<AbortController>();let closed=false;
 async function request(path:string,method:'GET'|'POST',input?:unknown):Promise<unknown>{
  if(closed)throw new BridgeError('TRANSPORT_CLOSED');
  const abort=new AbortController();pending.add(abort);
  const timer=setTimeout(()=>abort.abort(),10_000);timer.unref();
  try{
   const response=await fetcher(new URL(path,config.apiUrl),{method,redirect:'error',credentials:'omit',signal:abort.signal,headers:{authorization:`Bearer ${config.token}`,origin:config.origin,accept:'application/json',...(method==='POST'?{'content-type':'application/json'}:{})},...(method==='POST'?{body:JSON.stringify(input)}:{})});
   const length=response.headers.get('content-length');
   if(length!==null&&(!/^\d+$/.test(length)||Number(length)>MAX_RESPONSE_BYTES)){await response.body?.cancel();throw new BridgeError('RESPONSE_TOO_LARGE');}
   if(!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')??'')){await response.body?.cancel();throw new BridgeError('INVALID_RESPONSE');}
   if(response.body===null)throw new BridgeError('INVALID_RESPONSE');
   const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
   try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>MAX_RESPONSE_BYTES){await reader.cancel();throw new BridgeError('RESPONSE_TOO_LARGE');}chunks.push(part.value);}}finally{reader.releaseLock();}
   const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
   let value:unknown;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new BridgeError('INVALID_RESPONSE');}
   if(!response.ok){const code=typeof value==='object'&&value!==null&&'error'in value&&typeof value.error==='object'&&value.error!==null&&'code'in value.error&&typeof value.error.code==='string'&&SAFE_CODES.has(value.error.code)?value.error.code:'REQUEST_FAILED';throw new BridgeError(code,response.status);}
   return value;
  }catch(error){if(error instanceof BridgeError)throw error;throw new BridgeError(abort.signal.aborted?'REQUEST_CANCELLED':'TRANSPORT_ERROR');}
  finally{clearTimeout(timer);pending.delete(abort);}
 }
 return {listTools:()=>request('/api/v1/local-mcp/tools','GET'),callTool:(name:string,input:unknown)=>{if(!/^[a-z][a-z_]{0,63}$/.test(name))return Promise.reject(new BridgeError('INVALID_TOOL'));return request(`/api/v1/local-mcp/tools/${name}`,'POST',input);},close:()=>{closed=true;for(const controller of pending)controller.abort();}};
}
