#!/usr/bin/env node
/**
 * Run after a deploy: node scripts/smoke-hosted.mjs [https://workloom.pavelignatov.com]
 * Waits (up to ~6 minutes) for the new version to answer, then checks the things a broken start or a broken web build
 * would break. Exits non-zero with the failing check, so a bad deploy is noticed in the minute it happens.
 */
const base=(process.argv[2]??'https://workloom.pavelignatov.com').replace(/\/$/,'');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const get=async(path,options={})=>{try{return await fetch(base+path,{signal:AbortSignal.timeout(10_000),redirect:'manual',...options});}catch{return null;}};
const fail=message=>{console.error(`SMOKE FAILED: ${message}`);process.exit(1);};

let ready=false;
for(let attempt=1;attempt<=36&&!ready;attempt+=1){
 const response=await get('/healthz/ready');
 if(response?.status===200){const body=await response.json().catch(()=>null);ready=body?.status==='ok'&&body?.checks?.database==='ok'&&body?.checks?.schema==='ok';}
 if(!ready){console.log(`waiting for ${base} (${attempt}/36) ${response?response.status:'no answer'}`);await sleep(10_000);}
}
if(!ready)fail('/healthz/ready never reported database and schema ok');

const app=await get('/app');
if(app?.status!==200)fail(`/app answered ${app?.status??'nothing'}`);
const html=await app.text();
const bundle=/\/assets\/(mountApp-[A-Za-z0-9_-]+\.js)/.exec(html)?.[1]??/\/assets\/([A-Za-z0-9_-]+\.js)/.exec(html)?.[1];
if(!bundle)fail('/app does not reference a script bundle');
const script=await get(`/assets/${bundle}`);
if(script?.status!==200)fail(`the web bundle ${bundle} answered ${script?.status??'nothing'}`);
const me=await get('/api/v1/me');
if(me?.status!==401)fail(`/api/v1/me without a session should answer 401, got ${me?.status??'nothing'}`);
console.log(`SMOKE OK: ${base} is healthy, serves ${bundle}, and rejects anonymous API calls`);
