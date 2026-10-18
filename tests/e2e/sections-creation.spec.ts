// Root-owned private compiled QA only. Synthetic shared Auth + disposable PG60651; no lifecycle here.
import {expect,test,type Locator,type Page} from '@playwright/test';
import {sectionListResponseSchema,sectionResponseSchema,taskFieldDefinitionResponseSchema,taskFieldValueListResponseSchema,taskFieldValueResponseSchema} from '@workloom/contracts';
import {startFakeSharedAuth} from './support/fake-shared-auth.js';
import {requirePrivateMembershipDatabase} from './support/private-membership-fixture.js';
import {PRIVATE_APP as APP,allTasks,apiRead,apiWrite,choose,createFixtureTask,freshProject,observeCommands,openTable,requireValue,savedRow} from './support/asana-private-project.js';
import {showAllColumns} from './support/disclosures.js';
let provider:Awaited<ReturnType<typeof startFakeSharedAuth>>;
const frame=(page:Page)=>page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
const sectionButton=(page:Page,name:string,collapsed=false)=>page.getByRole('button',{name:`${collapsed?'Expand':'Collapse'} section “${name}”`,exact:true});
async function theme(page:Page,value:'light'|'dark'){const button=page.getByRole('button',{name:'Dark theme',exact:true});await expect(button).toBeVisible();if(await page.locator('html').getAttribute('data-theme')!==value)await button.click();await expect(page.locator('html')).toHaveAttribute('data-theme',value);}
async function addSection(page:Page){await page.getByRole('button',{name:'More add options',exact:true}).click();await page.getByRole('menu',{name:'Add to project',exact:true}).getByRole('menuitem',{name:'Add section',exact:true}).click();const input=page.getByRole('form',{name:'Add section',exact:true}).getByRole('textbox',{name:'Section name',exact:true});await expect(input).toBeFocused();return input;}
async function insideViewport(locator:Locator){await expect(locator).toBeVisible();await expect.poll(async()=>locator.evaluate(node=>{const box=node.getBoundingClientRect(),port=node.closest<HTMLElement>('[data-task-table-scroll]')?.getBoundingClientRect();return box.width>20&&box.height>10&&box.left>=Math.max(0,port?.left??0)-1&&box.right<=Math.min(innerWidth,port?.right??innerWidth)+1&&box.top>=Math.max(0,port?.top??0)-1&&box.bottom<=Math.min(innerHeight,port?.bottom??innerHeight)+1;}),{message:'The focused section control is entirely inside the actual visible viewport'}).toBe(true);}
async function labelInside(page:Page,name:string,collapsed=false){const button=sectionButton(page,name,collapsed);await insideViewport(button);await insideViewport(button.locator('span[title]').first());expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);}

test.describe('inline sections and horizontally stable group headers',()=>{
  test.describe.configure({mode:'serial'});test.use({viewport:{width:1440,height:720}});
  test.beforeAll(async({baseURL},info)=>{if(process.env.WORKLOOM_QA_RUN_AUTHORIZED!=='1'||baseURL!==APP||process.env.WORKLOOM_QA_BASE_URL!==APP||info.config.workers!==1)throw new Error('Explicit private QA49318 with one worker required.');if(info.project.use.trace!=='off'||info.project.use.video!=='off')throw new Error('Private Auth requires trace/video off.');requirePrivateMembershipDatabase();provider=await startFakeSharedAuth({port:49319,appOrigin:APP});});
  test.afterAll(async()=>{await provider?.close();});
  for(const selectedTheme of ['light','dark'] as const){
    test(`${selectedTheme}: Add section focuses and reveals the inline title, Escape cancels, Enter persists an empty section`,async({page},info)=>{
      const f=await freshProject(page,provider,`Sections creation ${selectedTheme}`);
      for(let index=0;index<18;index+=1)await createFixtureTask(f,`Saved task ${String(index).padStart(2,'0')}`);
      const before=await allTasks(f),sectionsPath=`${f.prefix}/projects/${f.projectId}/sections`;
      expect((await apiRead(page,sectionsPath,sectionListResponseSchema)).data).toHaveLength(0);
      await openTable(f);await theme(page,selectedTheme);const commands=observeCommands(page,f.prefix);
      let input=await addSection(page);await insideViewport(input);await expect(input).toHaveValue('');
      await input.press('Escape');await expect(page.getByRole('form',{name:'Add section',exact:true})).toHaveCount(0);
      expect(commands.commands).toHaveLength(0);expect((await apiRead(page,sectionsPath,sectionListResponseSchema)).data).toHaveLength(0);
      input=await addSection(page);await insideViewport(input);await expect(input).toBeFocused();
      const name=`Ready for review ${selectedTheme}`;await input.fill(name);
      const saved=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname===sectionsPath);
      await input.press('Enter');const response=await saved;expect(response.status()).toBe(201);const section=sectionResponseSchema.parse(await response.json()).data;expect(section.name).toBe(name);
      await expect(page.getByRole('form',{name:'Add section',exact:true})).toHaveCount(0);await labelInside(page,name);
      expect(commands.commands).toHaveLength(1);expect(commands.commands[0]).toMatchObject({path:sectionsPath,method:'POST'});expect(JSON.parse(requireValue(commands.commands[0]).body)).toEqual({name});expect(commands.commands[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
      expect(await allTasks(f)).toEqual(before);expect((await apiRead(page,sectionsPath,sectionListResponseSchema)).data).toEqual([section]);
      await page.reload();await expect(sectionButton(page,name)).toBeVisible();
      const search=page.getByRole('searchbox',{name:'Search tasks',exact:true});await search.fill('No task has this section filter phrase');await expect(page.locator('tr[data-task-row]')).toHaveCount(0);await expect(sectionButton(page,name)).toBeVisible();
      await search.fill('');await expect(page.locator('tr[data-task-row]')).toHaveCount(18);expect(await allTasks(f)).toEqual(before);expect(commands.commands).toHaveLength(1);commands.close();
      await page.screenshot({path:info.outputPath(`section-created-${selectedTheme}.png`)});
    });
    test(`${selectedTheme}: assignee context restores sections and far-column edits keep the section label and collapse action visible`,async({page},info)=>{
      const f=await freshProject(page,provider,`Sections horizontal ${selectedTheme}`),name=`Delivery ${selectedTheme}`;
      const section=(await apiWrite(page,`${f.prefix}/projects/${f.projectId}/sections`,{name},sectionResponseSchema)).data;
      const task=await createFixtureTask(f,'Task in the retained section',{sectionId:section.id,responsibleMembershipId:f.owner.id});
      await createFixtureTask(f,'Task without a section');const before=await allTasks(f),fields=[];
      for(let index=1;index<=3;index+=1)fields.push((await apiWrite(page,`${f.prefix}/fields`,{projectId:f.projectId,name:`Far choice ${index}`,type:'single_select',historyEnabled:true,locked:false,options:[{name:'Not started',color:null},{name:'Ready',color:'#16a34a'}]},taskFieldDefinitionResponseSchema)).data);
      const field=requireValue(fields.at(-1)),option=requireValue(field.options.find(item=>item.name==='Ready'));
      await openTable(f);await theme(page,selectedTheme);await showAllColumns(page);const commands=observeCommands(page,f.prefix);
      await choose(page,page.getByRole('main'),'Group by','Assignee');
      await expect(page.getByText('Grouped by assignee. Your sections are still available.',{exact:true})).toBeVisible();await expect(sectionButton(page,name)).toHaveCount(0);
      await page.getByRole('button',{name:'Show sections',exact:true}).click();await expect(page.getByRole('combobox',{name:'Group by',exact:true})).toContainText('Section');await labelInside(page,name);
      const scroller=page.locator('[data-task-table-scroll]');await scroller.hover();await page.mouse.wheel(4000,0);
      await expect.poll(()=>scroller.evaluate(node=>node.scrollLeft),{message:'The table actually reaches a far horizontal position'}).toBeGreaterThan(500);await frame(page);
      const farLeft=await scroller.evaluate(node=>node.scrollLeft);await labelInside(page,name);
      const control=savedRow(page,task.id).locator(`[data-inline-field-cell="${task.id}:${field.id}"]`).getByRole('combobox',{name:`Edit ${field.name} for ${task.title}`,exact:true});await insideViewport(control);
      const valuePath=`${f.prefix}/tasks/${task.id}/field-values/${field.id}`,saved=page.waitForResponse(response=>response.request().method()==='PUT'&&new URL(response.url()).pathname===valuePath);
      await control.click();await page.getByRole('option',{name:'Ready',exact:true}).click();const response=await saved;expect(response.status()).toBe(200);expect(taskFieldValueResponseSchema.parse(await response.json()).data.value).toEqual({type:'single_select',value:option.id});await expect(control).toContainText('Ready');
      await labelInside(page,name);expect(await scroller.evaluate(node=>node.scrollLeft)).toBeGreaterThanOrEqual(farLeft-2);
      await sectionButton(page,name).click();await expect(savedRow(page,task.id)).toHaveCount(0);await labelInside(page,name,true);await expect(sectionButton(page,name,true)).toHaveAttribute('aria-expanded','false');
      expect(commands.commands).toHaveLength(1);expect(commands.commands[0]).toMatchObject({path:valuePath,method:'PUT'});expect(JSON.parse(requireValue(commands.commands[0]).body)).toEqual({expectedRevision:0,expectedDefinitionRevision:field.revision,value:{type:'single_select',value:option.id}});
      expect((await apiRead(page,`${f.prefix}/tasks/${task.id}/field-values`,taskFieldValueListResponseSchema)).data).toHaveLength(1);expect(await allTasks(f)).toEqual(before);commands.close();
      await page.screenshot({path:info.outputPath(`section-far-collapsed-${selectedTheme}.png`)});
    });
  }
});
