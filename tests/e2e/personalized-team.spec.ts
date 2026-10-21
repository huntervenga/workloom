// Private fake Auth + throwaway PostgreSQL only. No production identities or imported team data.
// Secrets stay in memory: run with trace/video/automatic screenshots OFF; never attach request bodies or URLs.
// One explicit Members screenshot is allowed only after proving the fragment/DOM/storage are clean.
import { createHash, randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { meResponseSchema, membershipListResponseSchema, taskResponseSchema, teamViewResponseSchema } from '@workloom/contracts';
import { startFakeSharedAuth } from './support/fake-shared-auth.js';
import { PRIVATE_APP as APP, apiRead, createFixtureTask, freshProject } from './support/asana-private-project.js';

let provider: Awaited<ReturnType<typeof startFakeSharedAuth>>;
test.describe.configure({mode:'serial'});
test.beforeAll(async()=>{provider=await startFakeSharedAuth({port:49319,appOrigin:APP});});
test.afterAll(async()=>{await provider?.close();});
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
async function cleanBrowser(page:Page,secret:string){
  expect(await page.evaluate(value=>({fragment:location.hash==='',html:!document.documentElement.outerHTML.includes(value),local:!JSON.stringify(localStorage).includes(value),session:!JSON.stringify(sessionStorage).includes(value)}),secret)).toEqual({fragment:true,html:true,local:true,session:true});
}
async function addPerson(page:Page,email:string){
  await page.getByRole('textbox',{name:'First name',exact:true}).fill('Maya');
  await page.getByRole('textbox',{name:'Last name (optional)',exact:true}).fill('Chen');
  await page.getByRole('textbox',{name:'Work email',exact:true}).fill(email);
  await page.getByRole('button',{name:'Create invitation',exact:true}).click();
  await page.getByRole('button',{name:'Copy invitation link',exact:true}).click();
  return page.evaluate(()=>navigator.clipboard.readText());
}

test('personal invitation creates an assignable pending person; anonymous sign-in joins the same membership and keeps assigned work',async({page,context,browser},testInfo)=>{
  const f=await freshProject(page,provider,'Personal invitation');
  await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:APP});
  const email=`personal-${randomUUID()}@gmail.com`,recipient=provider.registerIdentity(`Personal recipient ${randomUUID()}`,{email});
  await page.goto(`${APP}/app/w/${f.workspaceId}/members`);
  const link=await addPerson(page,email),secret=new URL(link).hash.split('.')[1] ?? '';
  expect(secret.length).toBe(43);await cleanBrowser(page,secret);
  await expect(page.getByText('Not joined yet',{exact:true})).toBeVisible();
  await cleanBrowser(page,secret);
  await page.screenshot({path:testInfo.outputPath('personal-team-pending.png'),fullPage:false});
  const before=(await apiRead(page,`${f.prefix}/team`,teamViewResponseSchema)).data;
  const pending=before.members.find(member=>member.pending&&member.email===email);
  expect(Boolean(pending)).toBe(true);if(!pending)throw new Error('Pending person missing.');
  const task=await createFixtureTask(f,'Work prepared before joining',{responsibleMembershipId:pending.id});
  const guestContext=await browser.newContext(),guest=await guestContext.newPage();
  try{
    const authUrls:string[]=[];
    guest.on('request',request=>{const url=new URL(request.url());if(url.origin===provider.origin)authUrls.push(request.url());});
    await guest.goto(link);await cleanBrowser(guest,secret);
    await guest.getByRole('button',{name:'Sign in and join',exact:true}).click();
    await guest.getByRole('button',{name:recipient.buttonName,exact:true}).click();
    await expect.poll(()=>new URL(guest.url()).pathname).toBe(`/app/w/${f.workspaceId}/projects`);
    expect(authUrls.every(url=>!url.includes(secret))).toBe(true);
    const me=(await apiRead(guest,'/api/v1/me',meResponseSchema)).data;
    const after=(await apiRead(page,`${f.prefix}/team`,teamViewResponseSchema)).data;
    const claimed=after.members.find(member=>member.id===pending.id);
    expect(claimed?.pending).toBe(false);expect(claimed?.userId).toBe(me.actor.id);
    expect(after.members.filter(member=>member.userId===me.actor.id)).toHaveLength(1);
    const assigned=(await apiRead(guest,`${f.prefix}/tasks/${task.id}`,taskResponseSchema)).data;
    expect(assigned.responsibleMembershipId).toBe(pending.id);await cleanBrowser(guest,secret);
  }finally{await guestContext.close();}
});

test('a replacement after reload preserves the person and invalidates the older personal link',async({page,context,browser})=>{
  const f=await freshProject(page,provider,'Replace personal link');await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:APP});
  const email=`replace-${randomUUID()}@gmail.com`,recipient=provider.registerIdentity(`Replace recipient ${randomUUID()}`,{email});
  await page.goto(`${APP}/app/w/${f.workspaceId}/members`);const oldLink=await addPerson(page,email);
  const before=(await apiRead(page,`${f.prefix}/team`,teamViewResponseSchema)).data;
  const pending=before.members.find(member=>member.pending&&member.email===email);if(!pending)throw new Error('Pending person missing.');
  await page.reload();await expect(page.getByRole('button',{name:'Copy invitation link',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Create replacement link',exact:true}).click();
  await page.getByRole('button',{name:'Copy invitation link',exact:true}).click();const newLink=await page.evaluate(()=>navigator.clipboard.readText());
  expect(sha(newLink)).not.toBe(sha(oldLink));
  const after=(await apiRead(page,`${f.prefix}/team`,teamViewResponseSchema)).data;
  expect(after.members.filter(member=>member.pending&&member.email===email).map(member=>member.id)).toEqual([pending.id]);
  const oldId=new URL(oldLink).hash.slice(1).split('.')[0];expect(Boolean(after.invitations.find(invite=>invite.id===oldId)?.revokedAt)).toBe(true);
  const guestContext=await browser.newContext(),guest=await guestContext.newPage();
  try{
    await guest.goto(oldLink);await guest.getByRole('button',{name:'Sign in and join',exact:true}).click();
    await guest.getByRole('button',{name:recipient.buttonName,exact:true}).click();
    await expect(guest.getByRole('alert')).toContainText(/unavailable|could not be completed/i);
    expect(new URL(guest.url()).pathname).toBe('/app/join');
    await guest.goto(newLink);await guest.getByRole('button',{name:'Accept invitation',exact:true}).click();
    await expect.poll(()=>new URL(guest.url()).pathname).toBe(`/app/w/${f.workspaceId}/projects`);
  }finally{await guestContext.close();}
});

test('a different confirmed mailbox cannot claim the pending person and gets an actionable message',async({page,context,browser})=>{
  const f=await freshProject(page,provider,'Wrong personal account');await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:APP});
  const intended=`intended-${randomUUID()}@gmail.com`,wrong=provider.registerIdentity(`Wrong recipient ${randomUUID()}`,{email:`wrong-${randomUUID()}@gmail.com`});
  await page.goto(`${APP}/app/w/${f.workspaceId}/members`);const link=await addPerson(page,intended);
  const guestContext=await browser.newContext(),guest=await guestContext.newPage();
  try{
    await guest.goto(link);await guest.getByRole('button',{name:'Sign in and join',exact:true}).click();
    await guest.getByRole('button',{name:wrong.buttonName,exact:true}).click();
    await expect(guest.getByRole('alert')).toContainText('This invitation is for a different email.');
    await expect(guest.getByRole('button',{name:'Sign in with another account',exact:true})).toBeEnabled();
    const team=(await apiRead(page,`${f.prefix}/team`,teamViewResponseSchema)).data;
    expect(team.members.filter(member=>member.pending&&member.email===intended)).toHaveLength(1);
    expect(team.invitations.every(invite=>invite.acceptedAt===null)).toBe(true);
  }finally{await guestContext.close();}
});

test('legacy general links remain available and their cookie-bound resume retries exactly after a lost response',async({page,context,browser})=>{
  const f=await freshProject(page,provider,'Legacy invitation');await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:APP});
  await page.goto(`${APP}/app/w/${f.workspaceId}/members`);
  await page.getByRole('checkbox',{name:'Create a general invitation link instead',exact:true}).check();
  await page.getByRole('button',{name:'Create invitation',exact:true}).click();await page.getByRole('button',{name:'Copy invitation link',exact:true}).click();
  const link=await page.evaluate(()=>navigator.clipboard.readText());const recipient=provider.registerIdentity(`General recipient ${randomUUID()}`);
  const guestContext=await browser.newContext(),guest=await guestContext.newPage();
  try{
    const commands:{key:string|undefined;bodyHash:string;actor:string|undefined}[]=[];
    guest.on('request',request=>{if(new URL(request.url()).pathname==='/api/v1/auth/invitation-handoff/accept'&&request.method()==='POST')commands.push({key:request.headers()['idempotency-key'],bodyHash:sha(request.postData()??''),actor:request.headers()['x-workloom-actor-id']});});
    let first=true;await guest.route('**/api/v1/auth/invitation-handoff/accept',async route=>{if(!first){await route.continue();return;}first=false;const response=await route.fetch();expect(response.status()).toBe(200);await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'UNAVAILABLE',message:'Private test response loss'}})});});
    await guest.goto(link);await guest.getByRole('button',{name:'Sign in and join',exact:true}).click();await guest.getByRole('button',{name:recipient.buttonName,exact:true}).click();
    await guest.getByRole('button',{name:'Retry same action',exact:true}).click();
    await expect.poll(()=>new URL(guest.url()).pathname).toBe(`/app/w/${f.workspaceId}/projects`);
    expect(commands).toHaveLength(2);expect(commands[0]).toEqual(commands[1]);
    const members=(await apiRead(page,`${f.prefix}/memberships`,membershipListResponseSchema)).data;const me=(await apiRead(guest,'/api/v1/me',meResponseSchema)).data;
    expect(members.filter(member=>member.userId===me.actor.id)).toHaveLength(1);
  }finally{await guestContext.close();}
});
