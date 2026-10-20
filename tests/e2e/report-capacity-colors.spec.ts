// Isolated compiled QA only. Synthetic records never enter the user's database.
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { Temporal } from 'temporal-polyfill';
import { genericReportDefinitionResponseSchema, leaveAvailabilityResponseSchema, leaveOverviewResponseSchema, leaveProfileResponseSchema, leaveSettingsResponseSchema, taskFieldDefinitionResponseSchema, taskFieldValueResponseSchema, type GenericReportConfig } from '@workloom/contracts';
import { startFakeSharedAuth } from './support/fake-shared-auth.js';
import { requirePrivateMembershipDatabase } from './support/private-membership-fixture.js';
import { PRIVATE_APP as APP, apiRead, apiWrite, createFixtureTask, freshProject, requireValue, type DailyProject } from './support/asana-private-project.js';
let provider: Awaited<ReturnType<typeof startFakeSharedAuth>>;
async function put<T>(f:DailyProject,path:string,data:object,schema:{parse(value:unknown):T}) { const response=await f.page.request.put(`${APP}${path}`,{headers:{Origin:APP,'Idempotency-Key':randomUUID()},data});expect(response.status()).toBe(200);return schema.parse(await response.json()); }
async function fixture(page:Page,label:string) {
 const f=await freshProject(page,provider,label,true),fields=[];
 for(const name of ['Budget hours','Recorded hours'])fields.push((await apiWrite(page,`${f.prefix}/fields`,{projectId:f.projectId,name,type:'duration',historyEnabled:true,locked:false,options:[]},taskFieldDefinitionResponseSchema)).data);
 const plan=requireValue(fields[0]),fact=requireValue(fields[1]);
 const category=(await apiWrite(page,`${f.prefix}/fields`,{projectId:f.projectId,name:'Work category',type:'single_select',historyEnabled:true,locked:false,options:[{name:'Delivery',color:'#db2777'},{name:'Bugfix',color:'#0d9488'}]},taskFieldDefinitionResponseSchema)).data,option=requireValue(category.options[0]);
 const path=`${f.prefix}/time-off`;
 const initial=(await apiRead(page,`${path}/overview`,leaveOverviewResponseSchema)).data,today=initial.today;
 await apiWrite(page,`${path}/template`,{expectedRevision:0,effectiveYear:Number(today.slice(0,4)),includeCompanyHolidays:false},leaveSettingsResponseSchema);
 await put(f,`${path}/members/${f.owner.id}/profile`,{expectedRevision:0,timezone:'UTC',employmentStart:`${today.slice(0,4)}-01-01`,employmentEnd:null,accountingStart:`${today.slice(0,4)}-01-01`,openingBalances:[],schedulePeriods:[{effectiveFrom:today,weeklyMinutes:[480,480,480,480,480,0,0]}],reason:'Synthetic capacity and palette verification'},leaveProfileResponseSchema);
 const task=await createFixtureTask(f,'Delivery with ordinary configured fields',{responsibleMembershipId:f.owner.id,dueDate:today,statusId:f.doneId});
 for(const [field,value] of [[plan,{type:'duration',value:600}],[fact,{type:'duration',value:900}],[category,{type:'single_select',value:option.id}]] as const)await put(f,`${f.prefix}/tasks/${task.id}/field-values/${field.id}`,{expectedRevision:0,expectedDefinitionRevision:field.revision,value},taskFieldValueResponseSchema);
 const config:GenericReportConfig={projectId:f.projectId,hierarchy:'all_tasks',measures:[{key:'plan',operation:'sum',fieldId:plan.id},{key:'fact',operation:'sum',fieldId:fact.id}],comparison:{planFieldId:plan.id,factFieldId:fact.id,completion:'done_only'},groupBy:{kind:'category',fieldId:category.id},filters:{statusGroups:[],tagIds:[],assignee:{kind:'all'},dateRange:null}};
 const report=(await apiWrite(page,`${f.prefix}/generic-reports`,{name:'Capacity and categories',config},genericReportDefinitionResponseSchema)).data;
 return {f,report,category,option,today};
}
test.describe('report capacity and stored category colors',()=>{
 test.describe.configure({mode:'serial'});test.use({viewport:{width:1440,height:1000}});
 test.beforeAll(async({baseURL},info)=>{if(process.env.WORKLOOM_QA_RUN_AUTHORIZED!=='1'||baseURL!==APP||process.env.WORKLOOM_QA_BASE_URL!==APP||info.config.workers!==1)throw Error('PRIVATE_CAPACITY_COLOR_QA_REQUIRED');if(info.project.use.trace!=='off'||info.project.use.video!=='off')throw Error('NO_AUTH_RECORDING');requirePrivateMembershipDatabase();provider=await startFakeSharedAuth({port:49319,appOrigin:APP});});
 test.afterAll(async()=>{await provider?.close();});
 for(const theme of ['light','dark'] as const)test(`${theme}: explicit interval, known-person capacity and stored category colors`,async({page},info)=>{
  const {f,report,category,option,today}=await fixture(page,`Capacity ${theme}`),writes:string[]=[];
  page.on('request',request=>{if(request.method()!=='GET'&&/\/time-off\/(members\/|settings|template)/.test(new URL(request.url()).pathname))writes.push(request.method());});
  await page.goto(`${APP}/app/w/${f.workspaceId}/projects/${f.projectId}/reports?report=${report.id}`);
  if(await page.locator('html').getAttribute('data-theme')!==theme)await page.getByRole('button',{name:'Dark theme',exact:true}).click();
  const card=page.getByRole('article',{name:'Available capacity',exact:true});await expect(card).toContainText('Choose a date range');await expect(card.getByText('—',{exact:true})).toBeVisible();
  await card.getByRole('button',{name:'Show this week',exact:true}).click();
  await expect(card).toContainText('40h');await expect(card).toContainText(`Known schedules only · 1 of ${1+f.teammates.length} people`);
  const owner=page.getByRole('row',{name:new RegExp(f.owner.displayName)});await expect(owner).toContainText('40h');
  await expect(card.getByRole('link',{name:'Set up working hours',exact:true})).toHaveAttribute('href',`/app/w/${f.workspaceId}/time-off?tab=people#working-hours`);
  const projectCategory=page.locator(`[data-report-category-option="${option.id}"]`).first();
  await expect(projectCategory.locator('[data-category-swatch]')).toHaveCSS('background-color','rgb(219, 39, 119)');await expect(projectCategory.locator('[data-category-bar]')).toHaveCSS('background-color','rgb(219, 39, 119)');
  // Existing default schedule applies before the first effective override; an early date is not an unknown schedule.
  const date=Temporal.PlainDate.from(today),earlier=date.subtract({days:14}),from=earlier.subtract({days:earlier.dayOfWeek-1}).toString(),to=Temporal.PlainDate.from(from).add({days:6}).toString();
  const response=await apiWrite(page,`${f.prefix}/time-off/availability`,{startDate:from,endDate:to,people:{kind:'selected',membershipIds:[f.owner.id]}},leaveAvailabilityResponseSchema);
  expect(response.data.members[0]?.scheduleKnown).toBe(true);expect(response.data.totals.availableMinutes).toBe(2400);
  await page.goto(`${APP}/app/w/${f.workspaceId}/reports`);await page.getByRole('button',{name:'This week',exact:true}).click();
  await expect(page.getByRole('article',{name:'Available capacity',exact:true})).toContainText('40h');await expect(page.getByRole('article',{name:'Available capacity',exact:true})).toContainText('Known schedules only');
  const workspaceCategory=page.locator(`[data-report-category-option="${option.id}"]`);await expect(workspaceCategory.locator('[data-category-swatch]')).toHaveCSS('background-color','rgb(219, 39, 119)');
  await expect(workspaceCategory.locator('[data-category-bar]')).toHaveCSS('background-color','rgb(219, 39, 119)');
  expect(category.options[0]?.color).toBe('#db2777');expect(writes).toEqual([]);
  await page.screenshot({path:info.outputPath(`capacity-colors-${theme}.png`),fullPage:true});
  await page.goto(`${APP}/app/w/${f.workspaceId}/time-off?tab=people&person=${f.owner.id}#working-hours`);
  await expect(page.getByRole('region',{name:'People & schedules',exact:true})).toBeVisible();await expect(page.locator('#working-hours')).toBeInViewport();await expect(page.locator('#working-hours')).toContainText('Weekly scheduled hours: 40h');expect(writes).toEqual([]);
 });
});
