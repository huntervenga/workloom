// Root-owned compiled QA49318 + fake shared Auth49319 + disposable PostgreSQL only.
// One finite native scenario. No process lifecycle, secret reads, forced actions or deadline changes.
import {randomUUID} from 'node:crypto';
import {expect,test,type Page,type Response} from '@playwright/test';
import {taskFieldDefinitionResponseSchema,taskFieldPolicyResponseSchema,taskFieldPolicyStateResponseSchema,taskFieldValueResponseSchema,taskFieldValueListResponseSchema,taskTimelineResponseSchema,type TaskFieldValueDto} from '@workloom/contracts';
import {startFakeSharedAuth} from './support/fake-shared-auth.js';
import {requirePrivateMembershipDatabase} from './support/private-membership-fixture.js';
import {PRIVATE_APP as APP,apiRead,apiWrite,createFixtureTask,freshProject,observeCommands,openTable,requireValue,savedRow,showColumns,allTasks} from './support/asana-private-project.js';
import {openProjectActions} from './support/disclosures.js';
let provider:Awaited<ReturnType<typeof startFakeSharedAuth>>;
const isResponse=(response:Response,method:string,path:string)=>response.request().method()===method&&new URL(response.url()).pathname===path;
const pane=(page:Page)=>page.locator('[data-task-panel][data-state="open"]');
async function manager(page:Page,fieldName:string) {
  await openProjectActions(page);await page.getByRole('main').getByRole('button',{name:'Team columns',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Project columns',exact:true});
  await dialog.getByRole('button',{name:`Edit column “${fieldName}”`,exact:true}).click();
  await dialog.getByText('Rules',{exact:true}).click();
  await expect(dialog.getByLabel('Maximum changes per person, task and field',{exact:true})).toBeVisible();return dialog;
}
async function closeManager(page:Page) {const dialog=page.getByRole('dialog',{name:'Project columns',exact:true});await dialog.getByRole('button',{name:'Close',exact:true}).first().click();await expect(dialog).toHaveCount(0);}

test.describe('owner field rules pilot',()=>{
  test.describe.configure({mode:'serial'});test.use({viewport:{width:1440,height:1000}});test.setTimeout(150_000);
  test.beforeAll(async({baseURL},info)=>{
    if(process.env.WORKLOOM_QA_RUN_AUTHORIZED!=='1'||baseURL!==APP||process.env.WORKLOOM_QA_BASE_URL!==APP||info.config.workers!==1)throw new Error('Explicit guarded QA49318 with one worker is required.');
    if(info.project.use.trace!=='off'||info.project.use.video!=='off')throw new Error('Private Auth requires trace/video off.');
    requirePrivateMembershipDatabase();provider=await startFakeSharedAuth({port:49319,appOrigin:APP});
  });
  test.afterAll(async()=>{await provider?.close();});
  test('owner configures quota/deadline, keeps no-ops free, audits one explicit exact-retry exception, and blocks an atomic bulk change',async({page},info)=>{
    const f=await freshProject(page,provider,'Native field rules');
    const task=await createFixtureTask(f,'Field rules canonical task',{estimateMinutes:120}),other=await createFixtureTask(f,'Other unchanged task',{estimateMinutes:60});
    const field=(await apiWrite(page,`${f.prefix}/fields`,{projectId:f.projectId,name:'Pilot score',type:'number',historyEnabled:false,locked:false,options:[]},taskFieldDefinitionResponseSchema)).data;
    const policyPath=`${f.prefix}/fields/${field.id}/policy`,valuePath=`${f.prefix}/tasks/${task.id}/field-values/${field.id}`;
    const state=async()=>(await apiRead(page,`${valuePath}/policy-state`,taskFieldPolicyStateResponseSchema)).data;
    const values=async(id:string)=>(await apiRead(page,`${f.prefix}/tasks/${id}/field-values`,taskFieldValueListResponseSchema)).data;
    await openTable(f);const commands=observeCommands(page,f.prefix);
    let rules=await manager(page,field.name);
    await rules.getByLabel('Maximum changes per person, task and field',{exact:true}).fill('1');
    const firstPolicyResponse=page.waitForResponse(r=>isResponse(r,'PUT',policyPath));
    await rules.getByRole('button',{name:'Save rules',exact:true}).click();const policyResponse=await firstPolicyResponse;expect(policyResponse.status()).toBe(200);
    const policy=taskFieldPolicyResponseSchema.parse(await policyResponse.json()).data;expect(policy).toMatchObject({revision:1,maxChangesPerActor:1,lockAt:null});
    expect(policy.activatedAt).not.toBeNull();await closeManager(page);
    await page.goto(`${APP}/app/w/${f.workspaceId}/projects/${f.projectId}?view=table&task=${task.id}`);
    await expect(pane(page).getByLabel('Task name',{exact:true})).toHaveValue(task.title);
    const edit=async()=>{
      // Saved panes keep independent custom values inside the visible More fields disclosure.
      const more=pane(page).locator('summary').filter({hasText:/^More fields/});
      await expect(more).toHaveCount(1);await expect(more).toBeVisible();
      if(!await more.locator('..').evaluate(element=>element.hasAttribute('open')))await more.click();
      const control=pane(page).getByRole('button',{name:`Edit “${field.name}”`,exact:true});
      await expect(control).toBeVisible();await control.click();
      return page.getByRole('dialog',{name:`Value of “${field.name}”`,exact:true});
    };
    let editor=await edit();const firstValueResponse=page.waitForResponse(r=>isResponse(r,'PUT',valuePath));
    await editor.getByLabel(field.name,{exact:true}).fill('7');await editor.getByLabel(field.name,{exact:true}).press('Tab');
    const firstResponse=await firstValueResponse;expect(firstResponse.status()).toBe(200);const first=taskFieldValueResponseSchema.parse(await firstResponse.json()).data;
    expect(first).toMatchObject({revision:1,value:{type:'number',value:7}});await expect(editor).toHaveCount(0);expect((await state()).currentActorChangesUsed).toBe(1);
    // A new legitimate no-op remains allowed after quota exhaustion and consumes nothing.
    const noop=await page.request.put(`${APP}${valuePath}`,{headers:{Origin:APP,'Idempotency-Key':randomUUID()},data:{expectedRevision:1,expectedDefinitionRevision:field.revision,value:{type:'number',value:7}}});
    expect(noop.status()).toBe(200);expect(taskFieldValueResponseSchema.parse(await noop.json()).data).toEqual(first);expect((await state()).currentActorChangesUsed).toBe(1);
    editor=await edit();await expect(editor.getByText('You have used 1 of 1 changes for this task field. Your unsent value is kept.',{exact:true})).toBeVisible();
    await editor.getByRole('button',{name:'Make owner exception',exact:true}).click();await editor.getByLabel(field.name,{exact:true}).fill('9');
    const reason='Correct accidental pilot source entry';await editor.getByLabel('Reason for this exception',{exact:true}).fill(reason);
    let committed:TaskFieldValueDto|null=null,lose=true;
    await page.route(`**${valuePath}/exception`,async route=>{
      const response=await route.fetch();expect(response.status()).toBe(200);committed=taskFieldValueResponseSchema.parse(await response.json()).data;
      if(lose){lose=false;await route.abort('failed');}else await route.fulfill({response});
    });
    await editor.getByRole('button',{name:'Apply exception once',exact:true}).click();
    await expect.poll(()=>committed?.revision??null).toBe(2);
    await expect(editor.getByRole('button',{name:'Retry',exact:true})).toBeVisible();
    await editor.getByRole('button',{name:'Close',exact:true}).first().click();editor=await edit();
    await expect(editor.getByLabel(field.name,{exact:true})).toHaveValue('9');
    const retry=page.waitForResponse(r=>isResponse(r,'POST',`${valuePath}/exception`));await editor.getByRole('button',{name:'Retry',exact:true}).click();expect((await retry).status()).toBe(200);
    await expect(editor).toHaveCount(0);await page.unroute(`**${valuePath}/exception`);
    const exceptions=commands.commands.filter(c=>c.path===`${valuePath}/exception`);expect(exceptions).toHaveLength(2);
    const expectedException={expectedRevision:1,expectedDefinitionRevision:field.revision,expectedPolicyRevision:policy.revision,value:{type:'number',value:9},reason};
    expect(JSON.parse(requireValue(exceptions[0]).body)).toEqual(expectedException);expect(requireValue(exceptions[1]).body).toBe(requireValue(exceptions[0]).body);expect(requireValue(exceptions[1]).key).toBe(requireValue(exceptions[0]).key);
    expect((await state()).currentActorChangesUsed).toBe(2);
    const timeline=(await apiRead(page,`${f.prefix}/tasks/${task.id}/timeline?limit=50`,taskTimelineResponseSchema)).data;
    const corrections=timeline.flatMap(item=>item.type==='activity'?item.changes.filter(change=>change.field==='custom'&&change.ownerException!==undefined):[]);
    expect(corrections).toHaveLength(1);expect(corrections[0]).toMatchObject({field:'custom',availability:'opted_out',ownerException:{policyRevision:1,reason}});expect(corrections[0]).not.toHaveProperty('before');expect(corrections[0]).not.toHaveProperty('after');
    await expect(pane(page).getByText(reason,{exact:true})).toBeVisible();
    await pane(page).getByRole('button',{name:'Close',exact:true}).click();
    rules=await manager(page,field.name);
    const pastLocal=await page.evaluate(()=>{const d=new Date(Date.now()-60_000),pad=(n:number)=>String(n).padStart(2,'0');return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;});
    const deadlineInput=rules.locator('input[type="datetime-local"]');await deadlineInput.fill(pastLocal);
    const deadlineResponse=page.waitForResponse(r=>isResponse(r,'PUT',policyPath));await rules.getByRole('button',{name:'Save rules',exact:true}).click();expect((await deadlineResponse).status()).toBe(200);await closeManager(page);
    const beforeValues=await values(task.id),beforeOtherValues=await values(other.id),beforeTasks=await allTasks(f);
    await showColumns(page,[field.name]);
    await page.getByRole('button',{name:`Select task: ${task.title}`,exact:true}).click();await page.getByRole('button',{name:`Select task: ${other.title}`,exact:true}).click({modifiers:['Shift']});
    await savedRow(page,task.id).getByRole('button',{name:`Edit ${field.name} for ${task.title}`,exact:true}).click();
    const bulk=page.getByRole('dialog',{name:`Edit ${field.name} for ${task.title}`,exact:true});await bulk.getByLabel(field.name,{exact:true}).fill('55');
    const denied=page.waitForResponse(r=>isResponse(r,'POST',`${f.prefix}/tasks/bulk-update`));await bulk.getByLabel(field.name,{exact:true}).press('Tab');
    const denial=await denied;expect(denial.status()).toBe(409);expect((await denial.json()).error.code).toBe('FIELD_LOCKED');
    await expect(bulk.getByLabel(field.name,{exact:true})).toHaveValue('55');expect(await values(task.id)).toEqual(beforeValues);expect(await values(other.id)).toEqual(beforeOtherValues);expect(await allTasks(f)).toEqual(beforeTasks);
    const bulkWrites=commands.commands.filter(c=>c.path===`${f.prefix}/tasks/bulk-update`);expect(bulkWrites).toHaveLength(1);
    expect(JSON.parse(requireValue(bulkWrites[0]).body)).toEqual({projectId:f.projectId,tasks:[{taskId:task.id,expectedRevision:task.revision,expectedFieldValueRevision:2},{taskId:other.id,expectedRevision:other.revision,expectedFieldValueRevision:0}],changes:{customField:{fieldId:field.id,expectedDefinitionRevision:field.revision,value:{type:'number',value:55}}}});
    await bulk.press('Escape');await expect(bulk).toHaveCount(0);
    for(const width of [1440,390])for(const dark of [false,true]) {
      await page.setViewportSize({width,height:1000});const theme=page.getByRole('button',{name:'Dark theme',exact:true});if(await theme.getAttribute('aria-pressed')!==String(dark))await theme.click();
      rules=await manager(page,field.name);expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(0);
      const box=requireValue(await rules.boundingBox()??undefined);expect(box.x).toBeGreaterThanOrEqual(-1);expect(box.x+box.width).toBeLessThanOrEqual(width+1);
      await expect(rules.getByLabel('Maximum changes per person, task and field',{exact:true})).toHaveValue('1');await expect(rules.locator('input[type="datetime-local"]')).toHaveValue(pastLocal);
      await page.screenshot({path:info.outputPath(`field-rules-${width}-${dark?'dark':'light'}.png`)});await closeManager(page);
    }
    expect(commands.commands.filter(c=>c.path===policyPath)).toHaveLength(2);commands.close();
  });
});
