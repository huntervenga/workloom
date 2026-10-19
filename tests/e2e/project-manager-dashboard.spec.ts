// PRIVATE compiled QA only. Root owns the isolated lifecycle; no main accounts/data/services.
import {randomUUID} from 'node:crypto';
import {expect,test,type Page} from '@playwright/test';
import {Temporal} from 'temporal-polyfill';
import {genericReportDefinitionResponseSchema,genericReportResultResponseSchema,leaveOverviewResponseSchema,leaveProfileResponseSchema,leaveRequestResponseSchema,leaveSettingsResponseSchema,taskFieldDefinitionResponseSchema,taskFieldValueResponseSchema,type GenericReportConfig,type TaskDto,type TaskFieldDefinitionDto} from '@workloom/contracts';
import {startFakeSharedAuth} from './support/fake-shared-auth.js';
import {requirePrivateMembershipDatabase} from './support/private-membership-fixture.js';
import {PRIVATE_APP as APP,apiRead,apiWrite,createFixtureTask,freshProject,requireValue,type DailyProject} from './support/asana-private-project.js';
let provider:Awaited<ReturnType<typeof startFakeSharedAuth>>;
async function putValue(f:DailyProject,task:TaskDto,field:TaskFieldDefinitionDto,value:number|string){
 const response=await f.page.request.put(`${APP}${f.prefix}/tasks/${task.id}/field-values/${field.id}`,{headers:{Origin:APP,'Idempotency-Key':randomUUID()},data:{expectedRevision:0,expectedDefinitionRevision:field.revision,value:{type:field.type,value}}});expect(response.status()).toBe(200);taskFieldValueResponseSchema.parse(await response.json());
}
async function createField(f:DailyProject,name:string,type:'duration'|'single_select',names:string[]=[]){return(await apiWrite(f.page,`${f.prefix}/fields`,{projectId:f.projectId,name,type,historyEnabled:true,locked:false,options:names.map(option=>({name:option,color:null}))},taskFieldDefinitionResponseSchema)).data;}
async function fixture(page:Page){
 const f=await freshProject(page,provider,'Unified project manager dashboard',true),path=`${f.prefix}/time-off`;
 let overview=(await apiRead(page,`${path}/overview`,leaveOverviewResponseSchema)).data;const today=requireValue([overview.today,...overview.members.map(member=>member.today)].sort().at(-1));let monday=Temporal.PlainDate.from(today).add({days:7});while(monday.dayOfWeek!==1)monday=monday.add({days:1});const from=monday.toString(),to=monday.add({days:6}).toString(),year=monday.year;
 await apiWrite(page,`${path}/template`,{expectedRevision:0,effectiveYear:year,includeCompanyHolidays:false},leaveSettingsResponseSchema);
 const members=[f.owner,requireValue(f.teammates[0]),requireValue(f.teammates[1])]as const;
 for(const member of members){const response=await page.request.put(`${APP}${path}/members/${member.id}/profile`,{headers:{Origin:APP,'Idempotency-Key':randomUUID()},data:{expectedRevision:0,timezone:'UTC',employmentStart:`${year}-01-01`,employmentEnd:null,accountingStart:`${year}-01-01`,openingBalances:[],schedulePeriods:[{effectiveFrom:`${year}-01-01`,weeklyMinutes:[480,480,480,480,480,0,0]}],reason:''}});expect(response.status()).toBe(200);leaveProfileResponseSchema.parse(await response.json());}
 overview=(await apiRead(page,`${path}/overview`,leaveOverviewResponseSchema)).data;const unpaid=requireValue(overview.settings?.policyVersions.flatMap(version=>version.types).find(type=>type.pausesAccrual&&!type.consumesBalance));
 const leave=(await apiWrite(page,`${path}/requests`,{membershipId:f.owner.id,typeId:unpaid.id,startDate:from,endDate:from,note:'Private fixture reason never belongs in a project chart',reason:''},leaveRequestResponseSchema)).data;
 await apiWrite(page,`${path}/requests/${leave.id}/decision`,{expectedRevision:leave.revision,decision:'approve',approveNegative:false,reason:''},leaveRequestResponseSchema);
 const budget=await createField(f,'Budget','duration'),spent=await createField(f,'Spent','duration'),category=await createField(f,'Focus area','single_select',['Bugfix','Development']);
 for(const[title,member,status,planned,actual,option]of [
  ['Paired completed work',members[0],f.doneId,600,480,'Bugfix'],
  ['Recorded work without an estimate',members[0],f.doneId,null,120,'Bugfix'],
  ['Work in progress',members[1],requireValue(f.statuses.find(s=>s.group==='in_progress')).id,240,120,'Development'],
 ]as const){const task=await createFixtureTask(f,title,{responsibleMembershipId:member.id,statusId:status,dueDate:monday.add({days:1}).toString()});if(planned!==null)await putValue(f,task,budget,planned);await putValue(f,task,spent,actual);await putValue(f,task,category,requireValue(category.options.find(value=>value.name===option)).id);}
 const config:GenericReportConfig={projectId:f.projectId,hierarchy:'all_tasks',measures:[{key:'budget',operation:'sum',fieldId:budget.id},{key:'spent',operation:'sum',fieldId:spent.id}],comparison:{planFieldId:budget.id,factFieldId:spent.id,completion:'all_tasks'},groupBy:{kind:'category',fieldId:category.id},filters:{statusGroups:[],tagIds:[],assignee:{kind:'all'},dateRange:{source:{kind:'due_date'},from,to}},capacity:{startDate:from,endDate:to,people:{kind:'selected',membershipIds:members.map(member=>member.id)}}};
 const report=(await apiWrite(page,`${f.prefix}/generic-reports`,{name:'One manager dashboard',config},genericReportDefinitionResponseSchema)).data;return{f,members,report,from,to,category};
}
test.describe('unified project manager capacity plan and actual dashboard',()=>{
 test.use({viewport:{width:1440,height:1000}});
 test.beforeAll(async({baseURL},info)=>{if(baseURL!==APP||process.env.WORKLOOM_QA_BASE_URL!==APP||process.env.WORKLOOM_QA_RUN_AUTHORIZED!=='1'||info.config.workers!==1)throw Error('Explicit private compiled49318 and one worker required.');if(info.project.use.trace!=='off'||info.project.use.video!=='off')throw Error('Auth traces/video forbidden.');requirePrivateMembershipDatabase();provider=await startFakeSharedAuth({port:49319,appOrigin:APP});});
 test.afterAll(async()=>{await provider?.close();});
 for(const theme of ['light','dark']as const)test(`${theme}: one project dashboard combines capacity, full-scope plan/fact, people and work type without rewriting its report`,async({page},info)=>{
  const{f,members,report,from,to,category}=await fixture(page);
  const result=(await apiWrite(page,`${f.prefix}/generic-reports/${report.id}/query`,{expectedRevision:report.revision,snapshotId:null,offset:0,limit:1},genericReportResultResponseSchema)).data;
  expect(result.rows).toHaveLength(1);expect(result.totalTasks).toBe(3);expect(result.measures.find(m=>m.key==='budget')?.value?.decimal).toBe('840');expect(result.measures.find(m=>m.key==='spent')?.value?.decimal).toBe('720');expect(result.comparison?.fact?.decimal).toBe('600');expect(result.capacity?.totals.availableMinutes).toBe(6720);
  const writes:string[]=[];page.on('request',request=>{const path=new URL(request.url()).pathname;if(path.startsWith(f.prefix)&&['POST','PUT','PATCH','DELETE'].includes(request.method())&&!/\/(?:query|field-aggregates|availability)$/.test(path))writes.push(path);});
  await page.goto(`${APP}/app/w/${f.workspaceId}/projects/${f.projectId}/reports`);if(await page.locator('html').getAttribute('data-theme')!==theme)await page.getByRole('button',{name:'Dark theme',exact:true}).click();await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
  const dashboard=page.getByRole('region',{name:'Project dashboard',exact:true});await expect(dashboard).toBeVisible();await expect(page.getByRole('navigation',{name:'Project views',exact:true})).toBeVisible();await expect(page.getByRole('combobox',{name:'Saved reports',exact:true})).toContainText(report.name);
  await expect(dashboard.getByRole('article',{name:'Available capacity',exact:true})).toContainText('112h');await expect(dashboard.getByRole('article',{name:'Plan · Budget',exact:true})).toContainText('14h');await expect(dashboard.getByRole('article',{name:'Actual · Spent',exact:true})).toContainText('12h');await expect(dashboard).toContainText(`${from} through ${to} (inclusive)`);
  const people=dashboard.getByRole('region',{name:'Plan and actual by primary assignee',exact:true});await expect(people).toBeVisible();
  for(const[member,capacity,plan,fact]of[[members[0],'32h','10h','10h'],[members[1],'40h','4h','2h'],[members[2],'40h','—','—']]as const){const row=people.locator(`tr[data-report-person="${member.id}"]`);await expect(row).toHaveAttribute('aria-label',`${member.displayName} · Available: ${capacity} · Plan: ${plan} · Actual: ${fact}`);await expect(row).toBeVisible();await expect(row.locator('[data-series="capacity"]')).toHaveCount(1);}
  const owner=people.locator(`tr[data-report-person="${members[0].id}"]`);await expect(owner).toContainText('Actual / estimate: 80%');await expect(owner).toContainText('1 / 2 paired');await expect(owner.locator('[data-series="plan"]')).toHaveCount(1);await expect(owner.locator('[data-series="fact"]')).toHaveCount(1);
  await expect(dashboard.getByRole('region',{name:`Distribution by ${category.name}`,exact:true})).toBeVisible();await expect(dashboard).not.toContainText('Private fixture reason');await expect(page.locator('#task-time-week')).toHaveCount(0);await page.screenshot({path:info.outputPath(`project-manager-dashboard-${theme}.png`)});
  await page.getByRole('button',{name:'All time',exact:true}).click();await expect(dashboard.getByRole('article',{name:'Available capacity',exact:true})).toContainText('—');await expect(dashboard.getByRole('article',{name:'Actual · Spent',exact:true})).toContainText('12h');
  await page.getByRole('button',{name:'This week',exact:true}).click();await expect(dashboard.getByRole('article',{name:'Available capacity',exact:true})).toBeVisible();
  const saved=(await apiRead(page,`${f.prefix}/generic-reports/${report.id}`,genericReportDefinitionResponseSchema)).data;expect(saved).toEqual(report);expect(writes).toEqual([]);
 });
});
