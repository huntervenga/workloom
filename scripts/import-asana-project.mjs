#!/usr/bin/env node
/** Local, explicit Asana snapshot adapter. It composes public domain commands; no direct SQL writes. */
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,renameSync,mkdirSync,openSync,closeSync,fsyncSync,chmodSync,existsSync,statSync,realpathSync,lstatSync,unlinkSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseEnv,TextDecoder} from 'node:util';
import {Buffer} from 'node:buffer';
import {hostname} from 'node:os';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const GID=/^\d{1,254}$/;
const ROOT=realpathSync(join(dirname(fileURLToPath(import.meta.url)),'..'));
const fail=message=>{throw new Error(message);};
const sha=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const equal=(a,b)=>canonical(a)===canonical(b);
const required=(v,message)=>v===null||v===undefined?fail(message):v;
const gid=v=>typeof v==='string'&&GID.test(v)?v:fail('Source IDs must be nonempty decimal strings.');
const mail=v=>typeof v==='string'?v.trim().toLowerCase():'';
export function decodeSource(bytes){return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}
/** Source parser is bounded separately from each unchanged 50-row Workloom import artifact. */
export function parseSourceCsv(raw){
 if(Buffer.byteLength(raw)>10*1024*1024||raw.includes('\0')||!raw.isWellFormed())fail('Source CSV exceeds adapter bounds or contains unsafe Unicode.');
 const text=raw.replace(/^\ufeff/,'');const records=[];let row=[],cell='',quoted=false,closed=false,started=false;
 const pushCell=()=>{if(cell.length>20000)fail('Source cell exceeds 20000 characters.');row.push(cell);if(row.length>100)fail('Source has too many columns.');cell='';closed=false;started=false;};
 const pushRow=()=>{pushCell();records.push(row);row=[];if(records.length>2001)fail('Source has more than 2000 tasks.');};
 for(let i=0;i<text.length;i++){const c=text[i];if(quoted){if(c==='"'){if(text[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}else cell+=c;}else if(c===',')pushCell();else if(c==='\r'||c==='\n'){pushRow();if(c==='\r'&&text[i+1]==='\n')i++;}else if(c==='"'){if(started||cell||closed)fail('Malformed CSV quote.');quoted=true;started=true;}else{if(closed)fail('Characters after closing CSV quote.');cell+=c;started=true;}}
 if(quoted)fail('Unclosed source CSV quote.');if(started||closed||cell||row.length)pushRow();
 const headers=records.shift();if(!headers?.length||new Set(headers).size!==headers.length||records.some(r=>r.length!==headers.length))fail('Source CSV requires unique headers and consistent record widths.');
 return {headers,rows:records.map(cells=>Object.fromEntries(headers.map((h,i)=>[h,cells[i]])))};
}
export function decimalMinutes(value){
 const s=String(value);const m=/^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(s);if(!m)fail('Duration hours must be exact nonnegative decimal values.');const frac=m[2]??'',den=10n**BigInt(frac.length),num=BigInt(m[1])*den+BigInt(frac||'0'),minutes=num*60n;if(minutes%den!==0n||minutes/den>2147483647n)fail('Duration does not resolve to bounded whole minutes.');return Number(minutes/den);
}
const hues=['#f06a6a','#f1bd6c','#f8df72','#9bd5a0','#66c9cc','#7aa7ed','#b392e8','#ed91c0'];
function sourceColor(color,key){if(/^#[a-f0-9]{6}$/i.test(color??''))return color.toLowerCase();return ({red:'#f06a6a',orange:'#f1bd6c','yellow-orange':'#f8df72',yellow:'#f8df72',green:'#9bd5a0',blue:'#7aa7ed',purple:'#b392e8',pink:'#ed91c0'})[color]??hues[parseInt(sha(key).slice(0,4),16)%hues.length];}
function date(value){if(value===null||value===undefined||value==='')return null;if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)fail('Invalid source calendar date.');return value;}
function sourceFieldDefinition(f,duration){
 const id=gid(f.gid);if(typeof f.name!=='string'||!f.name.trim()||f.name.length>160)fail('Unsupported source field name.');
 if(f.resource_subtype==='number')return {gid:id,name:f.name,type:duration?'duration':'number',...(duration?{sourceUnit:duration.sourceUnit,sourceMeaning:duration.sourceMeaning}:{}),sourceDefinition:{gid:id,name:f.name,type:'number',precision:f.precision??null}};
 if(f.resource_subtype==='enum'){
  const options=(f.enum_options??[]).map(o=>({gid:gid(o.gid),name:o.name,color:sourceColor(o.color,o.gid),sourceColor:o.color??null,enabled:o.enabled!==false}));if(options.some(o=>!o.enabled)||new Set(options.map(o=>o.name)).size!==options.length)fail('Disabled or ambiguous enum options require explicit migration decisions.');
  return {gid:id,name:f.name,type:'single_select',options,sourceDefinition:{gid:id,name:f.name,type:'enum',options}};
 }fail('Unsupported source custom field type; nothing was written.');
}
/** Builds a complete, deterministic snapshot before a database command can execute. */
/**
 * Asana joins several dependencies into one comma-separated CSV cell. A cell is accepted when it is exactly one task name,
 * or when it splits at commas into names that each identify exactly one task in exactly one way; otherwise it stays unresolved.
 */
export function dependencyTargets(cell,sourceNames){
 const whole=sourceNames.get(cell);if(whole)return whole.length===1?[whole[0]]:null;
 const parts=cell.split(',');if(parts.length<2||parts.length>50)return null;
 const solutions=[];
 const walk=(index,found)=>{if(solutions.length>1)return;if(index===parts.length){solutions.push(found);return;}for(let end=index+1;end<=parts.length;end++){const gids=sourceNames.get(parts.slice(index,end).join(','));if(gids?.length===1)walk(end,[...found,gids[0]]);}};
 walk(0,[]);
 return solutions.length===1&&new Set(solutions[0]).size===solutions[0].length?solutions[0]:null;
}
export function prepareAsanaPlan({jsonText,csvText,mapping,workspaceId,sourceProjectId}){
 if(!UUID.test(workspaceId)||!GID.test(sourceProjectId)||mapping.version!==1||mapping.shareableScopeConfirmed!==true)fail('Explicit workspace, source project and confirmed shareable scope are required.');
 if(mapping.workspaceId&&mapping.workspaceId!==workspaceId)fail('Mapping workspace differs.');
 if(Buffer.byteLength(jsonText)>10*1024*1024||jsonText.includes('\0')||!jsonText.isWellFormed())fail('Source JSON exceeds bounds.');
 const data=JSON.parse(jsonText.replace(/^\ufeff/,''));if(!Array.isArray(data.data)||!data.data.length)fail('Expected a nonempty Asana data array.');
 const flat=[];const walk=(items,parent=null,depth=0)=>{if(depth>20)fail('Source hierarchy is too deep.');for(const t of items){gid(t.gid);if((t.parent?.gid??null)!==parent)fail('JSON parent reference disagrees with nested structure.');flat.push(t);walk(t.subtasks??[],t.gid,depth+1);}};walk(data.data);
 if(flat.length>2000||new Set(flat.map(t=>t.gid)).size!==flat.length)fail('Source has duplicate IDs or more than 2000 tasks.');
 const csv=parseSourceCsv(csvText),byId=new Map(csv.rows.map(r=>[gid(r['Task ID']),r]));if(byId.size!==csv.rows.length||!equal(flat.map(t=>t.gid),csv.rows.map(r=>r['Task ID'])))fail('JSON and CSV task identities/order differ. Export the same snapshot again.');
 const wsGid=gid(data.data[0].workspace?.gid);if(mapping.sourceNamespace!==`asana:${wsGid}`)fail('Source namespace must be the explicit Asana workspace identity.');
 const projects=new Map(),sections=new Map(),tags=new Map(),fields=new Map(),sourceNames=new Map();
 for(const t of flat){if(gid(t.workspace?.gid)!==wsGid)fail('Mixed source workspaces.');for(const p of t.projects??[])projects.set(gid(p.gid),p.name);sourceNames.set(t.name,[...(sourceNames.get(t.name)??[]),t.gid]);}
 const projectName=projects.get(sourceProjectId);if(!projectName||projectName.length>160)fail('Selected source project is absent or has an unsupported name.');
 for(const t of data.data){const m=t.memberships?.find(v=>v.project?.gid===sourceProjectId);if(!m)fail('Every source root must belong to the selected project.');if(m.section){const id=gid(m.section.gid);if(sections.has(id)&&sections.get(id).name!==m.section.name)fail('Conflicting source section identity.');sections.set(id,{gid:id,name:m.section.name});}}
 // The same tag or custom-field name can exist twice in Asana under different IDs (for example a second "Priority" field from
 // another project). Workloom keeps one of each name: the first seen is canonical and the others fold into it by name.
 const tagCanon=new Map(),fieldCanon=new Map(),fieldDefs=new Map(),tagByName=new Map(),fieldByName=new Map();
 for(const t of flat){for(const tag of t.tags??[]){if(!tagByName.has(tag.name))tagByName.set(tag.name,tag.gid);tagCanon.set(tag.gid,tagByName.get(tag.name));}for(const f of t.custom_fields??[]){if(!fieldByName.has(f.name))fieldByName.set(f.name,f.gid);fieldCanon.set(f.gid,fieldByName.get(f.name));if(f.gid===fieldByName.get(f.name)&&!fieldDefs.has(f.gid))fieldDefs.set(f.gid,f);}}
 const effectiveFields=t=>{const groups=new Map();for(const f of t.custom_fields??[]){const id=fieldCanon.get(f.gid);if(!groups.has(id))groups.set(id,[]);groups.get(id).push(f);}
  return [...groups.entries()].map(([id,list])=>{if(list.length===1&&list[0].gid===id)return list[0];const base=fieldDefs.get(id);if(!base)fail('Duplicate source field has no canonical definition.');
   // The CSV carries only the canonical (first) field's value for a repeated name, so a duplicate's value is not imported; the untouched task stays in provenance.
   return list.find(f=>f.gid===id)??{...base,...(base.resource_subtype==='enum'?{enum_value:null}:{number_value:null})};});};
 const tasks=flat.map(t=>{
  const r=required(byId.get(t.gid),'CSV row absent.');if(r.Name!==t.name||(r.Notes??'')!==(t.notes??'')||(r['Due Date']||null)!==(t.due_on??null)||(r['Start Date']||null)!==(t.start_on??null)||!!r['Completed At']!==!!t.completed)fail('JSON and CSV disagree on task content, dates or completion.');
  // Asana allows stray leading/trailing spaces in names; a title is trimmed by the domain anyway, and the untouched name stays in provenance.
  if(!t.name?.trim()||t.name.length>500||t.name.trim().length>500||(t.notes??'').length>20000)fail('Task text cannot be imported losslessly within current bounds.');
  if(t.due_at||t.start_at)fail('Timed dates require another adapter.');
  if(t.resource_subtype!=='default_task'&&!(t.resource_subtype==='milestone'&&mapping.unsupportedSubtypePolicy==='preserve_as_task'))fail('Nonordinary source tasks require an explicit preserve_as_task conversion decision.');
  const parentGid=t.parent?.gid??null;if((r['Parent task']||'')!==(t.parent?.name??''))fail('CSV parent label differs from JSON parent.');
  const section=t.memberships?.find(v=>v.project?.gid===sourceProjectId)?.section??null;if((r['Section/Column']||'')!==(section?.name??''))fail('Source section differs between files.');
  let responsibleMembershipId=null,sourceEmail='';if(t.assignee){sourceEmail=mail(r['Assignee Email']);if(!sourceEmail||r.Assignee!==t.assignee.name)fail('Assignee identity is missing or disagrees between files.');responsibleMembershipId=mapping.assignees?.[sourceEmail];if(!UUID.test(responsibleMembershipId??''))fail('Every source assignee needs an explicit confirmed membership mapping.');}else if(r.Assignee||r['Assignee Email'])fail('Source assignee differs between files.');
  const tagGids=[...new Set((t.tags??[]).map(tag=>{const id=gid(tagCanon.get(tag.gid)??tag.gid);if(/[|,]/.test(tag.name)||!tag.name||tag.name.length>80)fail('Ambiguous source tag delimiter or unsupported tag name.');const before=tags.get(id);if(before&&before.name!==tag.name)fail('Conflicting source tag identity.');tags.set(id,{gid:id,name:tag.name,color:sourceColor(tag.color,id),sourceColor:tag.color??null});return id;}))];
  if(!equal([...new Set(r.Tags?r.Tags.split(',').map(v=>v.trim()):[])].sort(),[...new Set((t.tags??[]).map(v=>v.name))].sort()))fail('Source tag labels differ between files.');
  if(new Set((t.custom_fields??[]).map(f=>f.gid)).size!==(t.custom_fields??[]).length)fail('Duplicate custom field identity on source task.');const customFields=effectiveFields(t);
  const values={};for(const f of customFields){const duration=mapping.durationFields?.[f.gid];if(duration&&(duration.sourceUnit!=='hours'||!['current_estimate','current_actual'].includes(duration.sourceMeaning)))fail('Explicit duration conversion decisions are invalid.');const definition=sourceFieldDefinition(f,duration),old=fields.get(f.gid);if(old&&!equal(old,definition))fail('Source field definitions disagree.');fields.set(f.gid,definition);
   if(definition.type==='single_select'){const option=f.enum_value;if((r[f.name]||'')!==(option?.name??''))fail('Enum differs between JSON and CSV.');values[f.gid]=option?gid(option.gid):null;if(option&&!definition.options.some(o=>o.gid===option.gid))fail('Unknown source enum option.');}
   else{const raw=f.number_value;if((raw===null||raw===undefined)!==!(r[f.name]??''))fail('Missing numeric value differs between files.');if(raw!==null&&raw!==undefined){if(!Number.isFinite(raw)||Number(r[f.name])!==raw)fail('Source numeric values differ.');values[f.gid]=definition.type==='duration'?decimalMinutes(r[f.name]):raw;}else values[f.gid]=null;}
  }
  const {subtasks,...originalTask}=t;const provenance={version:1,source:'asana_project_export',sourceProjectId,originalTask:{...originalTask,subtasks:(subtasks??[]).map(v=>v.gid)},originalCsv:r};
  if(JSON.stringify(provenance).length>20000)fail('Per-task provenance exceeds the existing preserved-cell limit.');
  return {gid:t.gid,title:t.name.trim(),description:t.notes??'',parentGid,sectionGid:section?.gid??null,responsibleMembershipId,sourceEmail,status:t.completed?'done':'todo',startDate:date(t.start_on),dueDate:date(t.due_on),tagGids,values,provenance};
 });
 for(const t of tasks)for(const f of fields.values())if(!Object.hasOwn(t.values,f.gid))fail('Source custom field catalogs differ between tasks.');
 if(new Set([...tags.values()].map(t=>t.name)).size!==tags.size||new Set([...fields.values()].map(f=>f.name)).size!==fields.size)fail('Ambiguous field or tag names require explicit mapping.');
 for(const id of Object.keys(mapping.durationFields??{}))if(!fields.has(id))fail('Mapped duration source field does not exist.');
 const edges=new Map(),unresolvedDependencies=[];for(const t of tasks){const r=byId.get(t.gid);for(const [column,predecessor]of [['Blocked By (Dependencies)',true],['Blocking (Dependencies)',false]]){if(!r[column])continue;const labelled=dependencyTargets(r[column],sourceNames);if(!labelled&&mapping.unresolvedDependencyPolicy==='preserve'){unresolvedDependencies.push({taskGid:t.gid,column,label:r[column]});continue;}if(!labelled)fail('Dependency label must identify exactly one source task.');for(const other of labelled){const a=predecessor?other:t.gid,b=predecessor?t.gid:other;if(a===b)fail('Self dependency.');edges.set(a+'>'+b,{predecessorGid:a,successorGid:b});}}}
 const summary={tasks:tasks.length,roots:tasks.filter(t=>!t.parentGid).length,subtasks:tasks.filter(t=>t.parentGid).length,sections:sections.size,tags:tags.size,fields:fields.size,completed:tasks.filter(t=>t.status==='done').length,assigned:tasks.filter(t=>t.responsibleMembershipId).length,dependencies:edges.size,descriptions:tasks.filter(t=>t.description).length,dueDates:tasks.filter(t=>t.dueDate).length,startDates:tasks.filter(t=>t.startDate).length,taggedTasks:tasks.filter(t=>t.tagGids.length).length,provenanceOnly:{sourceTimestampSets:flat.length,permalinks:flat.filter(t=>t.permalink_url).length,followerSets:flat.filter(t=>t.followers?.length).length,extraProjectMemberships:flat.filter(t=>(t.memberships??[]).some(m=>m.project?.gid!==sourceProjectId)).length,comments:'not_exported',history:'not_exported',attachments:'not_exported'},batches:Math.ceil(tasks.length/50),durationFields:Object.fromEntries([...fields.values()].filter(f=>f.type==='duration').map(f=>[f.gid,{name:f.name,filled:tasks.filter(t=>t.values[f.gid]!==null&&t.values[f.gid]!==undefined).length,explicitZeros:tasks.filter(t=>t.values[f.gid]===0).length,minutes:tasks.reduce((sum,t)=>sum+(t.values[f.gid]??0),0),rootMinutes:tasks.filter(t=>!t.parentGid).reduce((sum,t)=>sum+(t.values[f.gid]??0),0)}]))};
 if(unresolvedDependencies.length)summary.provenanceOnly.unresolvedExternalDependencies=unresolvedDependencies.length;
 const converted=flat.filter(t=>t.resource_subtype==='milestone').length;if(converted)summary.provenanceOnly.milestonesPreservedAsOrdinaryTasks=converted;
 return {version:1,workspaceId,sourceProjectId,...(unresolvedDependencies.length?{unresolvedDependencies}:{}),identityMapping:{assignees:mapping.assignees??{},approvedEmailAliases:mapping.approvedEmailAliases??{}},sourceWorkspaceId:wsGid,sourceNamespace:mapping.sourceNamespace,projectName,sections:[...sections.values()],tags:[...tags.values()],fields:[...fields.values()],tasks,dependencies:[...edges.values()],summary,sourceDigests:{json:sha(jsonText),csv:sha(csvText),mapping:sha(canonical(mapping))}};
}
function csvEncode(headers,rows){const cell=v=>'"'+String(v??'').replaceAll('"','""')+'"';return [headers,...rows].map(r=>r.map(cell).join(',')).join('\r\n')+'\r\n';}
export function canonicalBatches(plan,resources){
 const scalar=plan.fields.filter(f=>f.type!=='single_select');const headers=['External ID','Title','Description','Parent External ID','Assignee source ID','Status','Section source ID','Tags source IDs','Start Date','Due Date',...scalar.map(f=>'Field '+f.gid),'Asana source provenance'];
 return Array.from({length:Math.ceil(plan.tasks.length/50)},(_,i)=>{const tasks=plan.tasks.slice(i*50,i*50+50);const rows=tasks.map(t=>[t.gid,t.title,t.description,t.parentGid??'',t.sourceEmail,t.status,t.sectionGid??'',t.tagGids.join('|'),t.startDate??'',t.dueDate??'',...scalar.map(f=>(t.values[f.gid]===null||t.values[f.gid]===undefined)?'':f.type==='duration'?String(t.provenance.originalCsv[f.name]):String(t.values[f.gid])),JSON.stringify(t.provenance)]);const csvText=csvEncode(headers,rows);if(Buffer.byteLength(csvText)>1048576)fail('Prepared bounded artifact exceeds1MiB.');
  const mapping={externalIdColumn:0,titleColumn:1,descriptionColumn:2,parentExternalIdColumn:3,responsibleColumn:4,statusColumn:5,sectionColumn:6,tagsColumn:7,tagsDelimiter:'|',startDateColumn:8,dueDateColumn:9,dateFormat:'iso',shareableScopeConfirmed:true,assigneeIsParticipant:false,defaultStatusId:resources.statuses.todo,people:Object.entries(resources.people).map(([sourceValue,membershipId])=>({sourceValue,membershipId})),statuses:Object.entries(resources.statuses).map(([sourceValue,statusId])=>({sourceValue,statusId})),sections:Object.entries(resources.sections).map(([sourceValue,sectionId])=>({sourceValue,sectionId})),tags:Object.entries(resources.tags).map(([sourceValue,tagId])=>({sourceValue,tagId})),customFields:scalar.map((f,n)=>({column:10+n,fieldId:resources.fields[f.gid].id,expectedDefinitionRevision:resources.fields[f.gid].revision,empty:'missing',sourceMeaning:f.sourceMeaning??'ordinary',...(f.sourceUnit?{sourceUnit:f.sourceUnit}:{})})),preserveColumns:[headers.length-1]};
  return {index:i,csvText,mapping,sourceIds:tasks.map(t=>t.gid)};
 });
}
function privateSave(path,value){mkdirSync(dirname(path),{recursive:true,mode:0o700});const tmp=path+'.next',fd=openSync(tmp,'w',0o600);try{writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd)}renameSync(tmp,path);chmodSync(path,0o600);const dir=openSync(dirname(path),'r');try{fsyncSync(dir);}finally{closeSync(dir)}}
export class OperatorJournal{
 constructor(path,plan){this.path=path;this.planDigest=sha(canonical(plan));if(existsSync(path)){if(lstatSync(path).isSymbolicLink()||(statSync(path).mode&0o077)!==0)fail('Journal must be an owner-private regular file.');this.value=JSON.parse(readFileSync(path,'utf8'));if(this.value.version!==1||this.value.planDigest!==this.planDigest)fail('Journal belongs to different input or mapping.');}else{this.value={version:1,runId:randomUUID(),planDigest:this.planDigest,workspaceId:plan.workspaceId,sourceDigests:plan.sourceDigests,steps:{},phase:'prepared'};privateSave(path,this.value);}}
 async step(name,input,execute){let entry=this.value.steps[name];const inputDigest=sha(canonical(input));if(entry){if(entry.key!==sha(this.planDigest+'\0'+name+'\0'+entry.inputDigest))fail('Stored command key was changed.');if(entry.inputDigest!==sha(canonical(entry.input)))fail('Stored command input was changed.');if(entry.inputDigest!==inputDigest)fail('A journaled command input changed: '+name);if(entry.phase==='done'){if(entry.resultDigest!==sha(canonical(entry.result)))fail('Stored command result was changed.');return entry.result;}}else{entry={phase:'pending',key:sha(this.planDigest+'\0'+name+'\0'+inputDigest),inputDigest,input};this.value.steps[name]=entry;privateSave(this.path,this.value);}const result=await execute(entry.key);entry.result=result;entry.resultDigest=sha(canonical(result));entry.phase='done';privateSave(this.path,this.value);return result;}
 checkpoint(phase,data={}){this.value.phase=phase;Object.assign(this.value,data);privateSave(this.path,this.value);}
}

function localTarget(url,{testMode=false,hosted=false}={}){
 let target;try{target=new URL(url);}catch{fail('Database URL is invalid.');}
 // A hosted deployment writes to its own database (TLS options in the URL are expected); only local runs are pinned to the managed local database.
 if(hosted&&!testMode){if(!['postgres:','postgresql:'].includes(target.protocol))fail('Only PostgreSQL targets are accepted.');return;}
 if(!['postgres:','postgresql:'].includes(target.protocol)||!['127.0.0.1','localhost','[::1]'].includes(target.hostname)||target.search||target.hash)fail('Only explicit local PostgreSQL targets are accepted.');
 if(testMode){if(target.port!=='55433'||!/^\/workloom_[a-z0-9_]*test[a-z0-9_]*$/i.test(target.pathname))fail('Synthetic execution requires the isolated test PostgreSQL on55433.');}
 else if(target.port!=='55432'||target.pathname!=='/workloom_dev')fail('This operator accepts only the managed local55432 workloom_dev database.');
}
function journalLock(path){const file=join(path,'operator.lock');let fd;try{fd=openSync(file,'wx',0o600);}catch(error){if(error.code!=='EEXIST')throw error;const previous=JSON.parse(readFileSync(file,'utf8'));if(previous.host!==hostname())fail('Import is locked by another host.');let live=true;try{process.kill(previous.pid,0);}catch(e){if(e.code==='ESRCH')live=false;else throw e;}if(live)fail('Another operator process owns this journal.');unlinkSync(file);fd=openSync(file,'wx',0o600);}writeFileSync(fd,JSON.stringify({pid:process.pid,host:hostname()}));fsyncSync(fd);closeSync(fd);return ()=>unlinkSync(file);}
function secureDirectory(path){mkdirSync(path,{recursive:true,mode:0o700});if(lstatSync(path).isSymbolicLink()||!statSync(path).isDirectory())fail('Journal directory must be a real private directory.');chmodSync(path,0o700);}
/** Read-only owner/member checks. No provider sessions, tokens, cookies or impersonated HTTP. */
export function validateMemberMapping(plan,owner,members){
 const sourcePeople=new Map(plan.tasks.filter(t=>t.sourceEmail).map(t=>[t.sourceEmail,t.responsibleMembershipId]));
 const aliases=plan.identityMapping.approvedEmailAliases,configured=plan.identityMapping.assignees;
 if(Object.keys(configured).some(email=>!sourcePeople.has(email))||Object.keys(aliases).some(email=>!sourcePeople.has(email)))fail('Unused source identity mapping or approval alias.');
 if(new Set(sourcePeople.values()).size!==sourcePeople.size)fail('Different source people cannot silently share a target membership.');
 const usedAliases=new Set();
 for(const [email,id]of sourcePeople){const member=members.find(m=>m.id===id);if(!member||configured[email]!==id)fail('A mapped person is absent or revoked in this workspace.');
  if(id===owner.membershipId){if(member.user_id!==owner.userId||aliases[email]!=='workspace-owner')fail('Mapping the source owner requires the explicit workspace-owner alias pinned to the current owner.');usedAliases.add(email);}
  else{if(!member.email)fail('A nonowner target needs a persisted pending-member mailbox.');const target=mail(member.email);if(email===target){if(aliases[email]!==undefined)fail('An exact mailbox match must not have an unused alias.');}else{if(mail(aliases[email])!==target||aliases[email]==='workspace-owner')fail('Source mailbox differs from the active pending person without an exact approved alias.');usedAliases.add(email);}}
 }
 if(Object.keys(aliases).some(email=>!usedAliases.has(email)))fail('Unused approved identity alias.');
}
async function ownerContext(database,plan,ownerUserId){
 const owners=await database.sql`select u.id,u.display_name,u.kind,m.id membership_id from memberships m join users u on u.id=m.user_id where m.workspace_id=${plan.workspaceId} and m.role='owner' and m.state='active' and u.kind='real' and exists(select 1 from shared_auth_identities i where i.user_id=u.id)`;
 if(owners.length!==1||!UUID.test(ownerUserId??'')||owners[0].id!==ownerUserId)fail('Exactly one active Auth-bound real workspace owner must match the explicit private mapping.');
 const members=await database.sql`select m.id,m.user_id,p.email from memberships m left join team_pending_members p on p.workspace_id=m.workspace_id and p.membership_id=m.id where m.workspace_id=${plan.workspaceId} and m.state='active'`;
 validateMemberMapping(plan,{userId:ownerUserId,membershipId:owners[0].membership_id},members);
 return {workspaceId:plan.workspaceId,actor:{userId:owners[0].id,displayName:owners[0].display_name,kind:'real'},source:'import',requestId:'local-asana-operator'};
}
function virtualResources(plan){const id=key=>{const s=sha(key).slice(0,32);return `${s.slice(0,8)}-${s.slice(8,12)}-4${s.slice(13,16)}-8${s.slice(17,20)}-${s.slice(20)}`;};return {statuses:{todo:id('todo'),done:id('done')},people:Object.fromEntries(plan.tasks.filter(t=>t.sourceEmail).map(t=>[t.sourceEmail,t.responsibleMembershipId])),sections:Object.fromEntries(plan.sections.map(s=>[s.gid,id('section'+s.gid)])),tags:Object.fromEntries(plan.tags.map(t=>[t.gid,id('tag'+t.gid)])),fields:Object.fromEntries(plan.fields.map(f=>[f.gid,{id:id('field'+f.gid),revision:1}]))};}
async function validatePrepared(plan){
 const c=await import('@workloom/contracts'),r=virtualResources(plan);
 c.createProjectInputSchema.parse({name:plan.projectName});
 for(const [position,s]of plan.sections.entries())c.createSectionInputSchema.parse({name:s.name,position});
 for(const t of plan.tags)c.createTagInputSchema.parse({name:t.name,color:t.color});
 for(const f of plan.fields)c.createTaskFieldInputSchema.parse({projectId:plan.workspaceId,name:f.name,type:f.type,historyEnabled:true,locked:false,options:(f.options??[]).map(o=>({name:o.name,color:o.color}))});
 for(const t of plan.tasks){c.createTaskInputSchema.parse({projectId:plan.workspaceId,title:t.title,description:t.description,statusId:r.statuses[t.status],sectionId:t.sectionGid?r.sections[t.sectionGid]:null,responsibleMembershipId:t.responsibleMembershipId,participantMembershipIds:[],tagIds:t.tagGids.map(g=>r.tags[g]),startDate:t.startDate,dueDate:t.dueDate,estimateMinutes:null,workScope:'added_scope'});for(const f of plan.fields){const v=t.values[f.gid];if(v!==null&&v!==undefined&&f.type!=='single_select')c.taskFieldDataSchema.parse({type:f.type,value:v});}}
 for(const batch of canonicalBatches(plan,r)){c.stageCsvImportInputSchema.parse({fileName:'prepared.csv',sourceNamespace:plan.sourceNamespace,csvText:batch.csvText});c.projectImportMappingSchema.parse(batch.mapping);const parsed=parseSourceCsv(batch.csvText);if(parsed.rows.length>50)fail('Prepared batch exceeds public50row limit.');}
}
/** Fresh domain reads verify every identity/value/edge and sibling order; cached command results are not acceptance. */
export async function reconcileAsana(plan,apps,ctx,resources,idMap){
 const differences=[];const check=(condition,path)=>{if(!condition)differences.push(path);};
 const project=await apps.tasks.getProject(ctx,resources.project.id);check(project.name===plan.projectName,'project.name');
 const sections=await apps.tasks.listSections(ctx,project.id);check(equal(sections.filter(s=>!s.archivedAt).sort((a,b)=>a.position-b.position).map(s=>({id:s.id,name:s.name})),plan.sections.map(s=>({id:resources.sections[s.gid],name:s.name}))),'sections.order/name');
 const tagCatalog=await apps.tasks.listTags(ctx);for(const t of plan.tags){const native=tagCatalog.find(v=>v.id===resources.tags[t.gid]);check(native?.name===t.name&&native?.color===t.color&&!native.archivedAt,'tag.'+t.gid);}
 const sharedColumns=await apps.fields.getProjectColumns(ctx,project.id),personalColumns=await apps.preferences.getPreference(ctx,project.id);check(equal(sharedColumns.columns,resources.projectColumns),'columns.shared');check(equal(personalColumns.columns,resources.personalColumns),'columns.personal');
 const rows=[];let cursor;do{const page=await apps.tasks.listTasks(ctx,{projectId:project.id,sort:'manual',limit:200,...(cursor?{cursor}:{})});rows.push(...page.items);cursor=page.nextCursor;}while(cursor);
 check(rows.length===plan.tasks.length,'task.count');check(Object.keys(idMap).length===plan.tasks.length,'source.identity.count');
 const actual=new Map(rows.map(t=>[t.id,t]));const fieldRows=[];for(let i=0;i<rows.length;i+=200)fieldRows.push(...await apps.fields.listProjectValues(ctx,project.id,{taskIds:rows.slice(i,i+200).map(t=>t.id)}));
 const actualFields=await apps.fields.listFields(ctx,project.id);check(actualFields.length===plan.fields.length,'field.count');
 for(const f of plan.fields){const found=actualFields.find(v=>v.id===resources.fields[f.gid].id);check(found?.name===f.name&&found?.type===f.type,'field.'+f.gid);if(f.options)check(equal(found?.options.map(o=>({name:o.name,color:o.color})),f.options.map(o=>({name:o.name,color:o.color}))),'field.options.'+f.gid);}
 for(const t of plan.tasks){const a=actual.get(idMap[t.gid]);if(!a){differences.push('task.absent.'+t.gid);continue;}
  const expected={title:t.title,description:t.description,parentTaskId:t.parentGid?idMap[t.parentGid]:null,sectionId:t.sectionGid?resources.sections[t.sectionGid]:null,responsibleMembershipId:t.responsibleMembershipId,statusId:resources.statuses[t.status],startDate:t.startDate,dueDate:t.dueDate};
  for(const [key,value]of Object.entries(expected))check(equal(a[key]??null,value),'task.'+t.gid+'.'+key);
  check(equal(a.tags.map(v=>v.id).sort(),t.tagGids.map(g=>resources.tags[g]).sort()),'task.'+t.gid+'.tags');check(a.estimateMinutes===null,'task.'+t.gid+'.noLegacyEstimate');check(a.participants.length===0,'task.'+t.gid+'.noInventedParticipants');
  for(const f of plan.fields){const row=fieldRows.find(v=>v.taskId===a.id&&v.fieldId===resources.fields[f.gid].id),v=t.values[f.gid];if(v===null||v===undefined)check(!row,'task.'+t.gid+'.missing.'+f.gid);else check(equal(row?.value,{type:f.type,value:f.type==='single_select'?resources.options[f.gid][v]:v}),'task.'+t.gid+'.value.'+f.gid);}
 }
 const groups=new Map();for(const t of plan.tasks){const key=(t.parentGid??'root')+'|'+(t.sectionGid??'none');groups.set(key,[...(groups.get(key)??[]),t]);}
 for(const [key,list]of groups){const ids=list.map(t=>idMap[t.gid]);const ordered=rows.filter(a=>ids.includes(a.id)).sort((a,b)=>a.position-b.position);check(equal(ordered.map(a=>a.id),ids),'order.'+key);}
 const edges=[];cursor=undefined;do{const page=await apps.dependencies.listDependencies(ctx,{projectId:project.id,state:'active',limit:100,...(cursor?{cursor}:{})});edges.push(...page.items);cursor=page.nextCursor;}while(cursor);
 const expectedEdges=plan.dependencies.map(e=>[idMap[e.predecessorGid],idMap[e.successorGid],'finish_to_start'].join('|')).sort();check(equal(edges.map(e=>[e.predecessorTaskId,e.successorTaskId,e.type].join('|')).sort(),expectedEdges),'dependencies');
 const totals=Object.fromEntries(plan.fields.filter(f=>f.type==='duration').map(f=>[f.gid,fieldRows.filter(v=>v.fieldId===resources.fields[f.gid].id).reduce((sum,v)=>sum+(v.value.value??0),0)]));for(const [g,v]of Object.entries(totals))check(v===plan.summary.durationFields[g].minutes,'totals.'+g);
 for(const artifact of resources.imports){const stored=await apps.imports.getImport(ctx,project.id,artifact.id),idx=stored.headers.indexOf('Asana source provenance');for(const row of stored.sourceRows){const sourceId=row.cells[0],expected=plan.tasks.find(t=>t.gid===sourceId);check(!!expected&&equal(JSON.parse(row.cells[idx]),expected.provenance),'provenance.'+sourceId);}}
 for(const f of plan.fields.filter(f=>f.type==='duration')){const values=fieldRows.filter(v=>v.fieldId===resources.fields[f.gid].id);check(values.length===plan.summary.durationFields[f.gid].filled,'filled.'+f.gid);check(values.filter(v=>v.value.value===0).length===plan.summary.durationFields[f.gid].explicitZeros,'zeros.'+f.gid);}
 return {status:differences.length?'mismatch':'verified',taskCount:rows.length,checkedAt:new Date().toISOString(),differences,totals};
}
/** All mutations are existing authorized domain commands, each journaled before invocation. */
export async function executeAsanaImport(plan,{databaseUrl,ownerUserId,journalDir,testMode=false,hosted=false,planOnly=false,afterStep}={}){
 localTarget(databaseUrl,{testMode,hosted});await validatePrepared(plan);secureDirectory(journalDir);
 const release=journalLock(journalDir);const lib=await import('@workloom/db'),database=lib.createDatabase(databaseUrl,{requireLoopback:!hosted,maxConnections:3,applicationName:'workloom-local-asana-operator'});
 try{
  let ctx=await ownerContext(database,plan,ownerUserId);
  if(planOnly){if(existsSync(join(journalDir,'journal.json')))new OperatorJournal(join(journalDir,'journal.json'),plan);privateSave(join(journalDir,'plan.json'),plan);return {status:'planned',summary:plan.summary};}
  const journal=new OperatorJournal(join(journalDir,'journal.json'),plan);
  privateSave(join(journalDir,'plan.json'),plan);
  if(journal.value.ownerUserId&&journal.value.ownerUserId!==ownerUserId)fail('The journal belongs to another authorized owner.');
  journal.checkpoint(journal.value.phase,{ownerUserId});
  const references=await database.sql`select external_id,project_id from external_import_references where workspace_id=${plan.workspaceId} and source_namespace=${plan.sourceNamespace}`;
  const previousProject=journal.value.steps['project.create']?.result?.id;
  if(references.some(r=>plan.tasks.some(t=>t.gid===r.external_id)&&r.project_id!==previousProject))fail('Source tasks already belong to another import journal/project. Resume its original durable journal.');
  const apps={tasks:lib.createTaskApplication(database),fields:lib.createTaskFieldApplication(database),imports:lib.createProjectImportApplication(database),dependencies:lib.createDependencyApplication(database),preferences:lib.createPersonalTablePreferenceApplication(database)};
  const command=async(name,input,fn)=>{ctx=await ownerContext(database,plan,ownerUserId);return journal.step(name,input,async key=>{const result=await fn({...ctx,idempotencyKey:key,requestId:'asana-operator:'+journal.value.runId});if(afterStep)await afterStep(name,result);return result;});};
  journal.checkpoint('applying');
  const project=await command('project.create',{name:plan.projectName},c=>apps.tasks.createProject(c,{name:plan.projectName}));
  const statuses=await apps.tasks.listStatuses(ctx,project.id),resources={project,statuses:{},people:virtualResources(plan).people,sections:{},tags:{},fields:{},options:{},imports:[]};
  for(const group of ['todo','done']){const matches=statuses.filter(s=>s.group===group&&!s.archivedAt);if(matches.length!==1)fail('Expected a unique default task status group.');resources.statuses[group]=matches[0].id;}
  for(const [position,s]of plan.sections.entries()){const input={name:s.name,position};const result=await command('section.'+s.gid,{projectId:project.id,...input},c=>apps.tasks.createSection(c,project.id,input));resources.sections[s.gid]=result.id;}
  for(const t of plan.tags){const input={name:t.name,color:t.color};const result=await command('tag.'+t.gid,input,c=>apps.tasks.createTag(c,input));resources.tags[t.gid]=result.id;}
  for(const f of plan.fields){const input={projectId:project.id,name:f.name,type:f.type,historyEnabled:true,locked:false,options:(f.options??[]).map(o=>({name:o.name,color:o.color}))};const result=await command('field.'+f.gid,input,c=>apps.fields.createField(c,input));resources.fields[f.gid]=result;resources.options[f.gid]=Object.fromEntries((f.options??[]).map((o,i)=>[o.gid,result.options[i].id]));}
  const columns=await apps.fields.getProjectColumns(ctx,project.id),columnInput={expectedRevision:journal.value.steps['columns.shared']?.input.expectedRevision??columns.revision,columns:plan.fields.map((f,position)=>({fieldId:resources.fields[f.gid].id,visible:true,width:f.type==='single_select'?150:160,position}))};
  resources.projectColumns=columnInput.columns;
  await command('columns.shared',columnInput,c=>apps.fields.updateProjectColumns(c,project.id,columnInput));
  const idMap={};for(const batch of canonicalBatches(plan,resources)){
   const stagedInput={fileName:`asana-part-${batch.index+1}.csv`,sourceNamespace:plan.sourceNamespace,csvText:batch.csvText};
   const artifact=await command('stage.'+batch.index,{projectId:project.id,...stagedInput},c=>apps.imports.stageCsv(c,project.id,stagedInput));
   const previewInput={expectedImportRevision:artifact.revision,mapping:batch.mapping};
   const preview=await command('preview.'+batch.index,{importId:artifact.id,...previewInput},c=>apps.imports.previewImport(c,project.id,artifact.id,previewInput));
   if(preview.issues.some(v=>v.severity==='blocking')||preview.summary.conflictCount||preview.summary.blockedCount)fail('A prepared batch has blocking issues; inspect the private journal preview.');
   const applyInput={...previewInput,previewHash:preview.previewHash};
   const applied=await command('apply.'+batch.index,{importId:artifact.id,...applyInput},c=>apps.imports.applyImport(c,project.id,artifact.id,applyInput));
   resources.imports.push({id:artifact.id,index:batch.index});
   const fresh=await apps.imports.getReconciliation(ctx,project.id,artifact.id);if(fresh.status!=='applied'||!equal(fresh.rows,applied.reconciliation.rows))fail('Batch reconciliation differs from the applied command receipt.');
   for(const row of fresh.rows){if(idMap[row.externalId])fail('A source identity occurred in more than one batch.');idMap[row.externalId]=row.targetTaskId;}
   journal.checkpoint('applying',{projectId:project.id,completedBatches:batch.index+1,idMap});
  }
  for(const t of plan.tasks)for(const f of plan.fields.filter(f=>f.type==='single_select')){const v=t.values[f.gid];if(v===null||v===undefined)continue;const input={expectedRevision:0,expectedDefinitionRevision:resources.fields[f.gid].revision,value:{type:'single_select',value:resources.options[f.gid][v]}};await command('enum.'+t.gid+'.'+f.gid,{taskId:idMap[t.gid],fieldId:resources.fields[f.gid].id,...input},c=>apps.fields.setTaskValue(c,idMap[t.gid],resources.fields[f.gid].id,input));}
  for(const edge of plan.dependencies){const input={predecessorTaskId:idMap[edge.predecessorGid],successorTaskId:idMap[edge.successorGid],type:'finish_to_start',expectedAbsent:true};await command('dependency.'+edge.predecessorGid+'.'+edge.successorGid,input,c=>apps.dependencies.createDependency(c,input));}
  const preference=await apps.preferences.getPreference(ctx,project.id);const visible=['title','responsible','dueDate','tags'],hidden=['status','participants','priority','estimate','weeklyPlan','weeklyActual'];
  const preferenceInput={expectedRevision:journal.value.steps['columns.personal']?.input.expectedRevision??preference.revision,columns:[...visible.map(key=>({column:{kind:'builtin',key},visible:true})),...plan.fields.map(f=>({column:{kind:'field',fieldId:resources.fields[f.gid].id},visible:true})),...hidden.map(key=>({column:{kind:'builtin',key},visible:false}))]};
  resources.personalColumns=preferenceInput.columns;
  await command('columns.personal',preferenceInput,c=>apps.preferences.setPreference(c,project.id,preferenceInput));
  ctx=await ownerContext(database,plan,ownerUserId);const verification=await reconcileAsana(plan,apps,ctx,resources,idMap);privateSave(join(journalDir,'reconciliation.json'),verification);
  if(verification.differences.length){journal.checkpoint('reconciliation_failed',{verification});fail('Readback has mismatches; inspect private reconciliation.json. Existing writes were retained for investigation.');}
  journal.checkpoint('complete',{projectId:project.id,idMap,verification});return {status:'verified',projectId:project.id,summary:plan.summary,verification};
 }finally{try{await database.close();}finally{release();}}
}
function cliArguments(argv){const args={};for(let i=0;i<argv.length;i++){const key=argv[i];if(['--plan','--apply'].includes(key)){args[key.slice(2)]=true;continue;}if(!['--workspace-id','--source-project-id','--json','--csv','--mapping','--journal-dir'].includes(key)||!argv[i+1]||argv[i+1].startsWith('--'))fail('Unknown or incomplete operator argument.');args[key.slice(2)]=argv[++i];}if(args.plan===args.apply)fail('Select exactly one of--plan or--apply.');for(const k of ['workspace-id','source-project-id','json','csv','mapping','journal-dir'])required(args[k],'Missing operator argument: '+k);return args;}
async function main(){
 const args=cliArguments(process.argv.slice(2));const env={...(existsSync(join(ROOT,'.env'))?parseEnv(readFileSync(join(ROOT,'.env'),'utf8')):{}),...process.env};if(env.APP_ENV!=='local'||env.AUTH_MODE!=='shared')fail('Run only with APP_ENV=local and AUTH_MODE=shared.');
 const mappingPath=resolve(args.mapping);if((statSync(mappingPath).mode&0o077)!==0)fail('Private mapping file must be accessible only to its owner.');
 const mapping=JSON.parse(readFileSync(mappingPath,'utf8')),jsonBytes=readFileSync(resolve(args.json)),csvBytes=readFileSync(resolve(args.csv));
 const plan=prepareAsanaPlan({jsonText:decodeSource(jsonBytes),csvText:decodeSource(csvBytes),mapping,workspaceId:args['workspace-id'],sourceProjectId:args['source-project-id']});
 const journalDir=resolve(args['journal-dir']);secureDirectory(journalDir);
 for(const [name,bytes]of [['source.json',jsonBytes],['source.csv',csvBytes],['mapping.json',readFileSync(mappingPath)]]){const target=join(journalDir,name);if(existsSync(target)){if(sha(readFileSync(target))!==sha(bytes))fail('Private source archive differs from this run.');}else{writeFileSync(target,bytes,{mode:0o600,flag:'wx'});const fd=openSync(target,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}}
 const result=await executeAsanaImport(plan,{databaseUrl:env.DATABASE_URL,ownerUserId:mapping.ownerUserId,journalDir,planOnly:!!args.plan});process.stdout.write(JSON.stringify(result,null,2)+'\n');
}
export {sha,canonical,equal,fail,privateSave,secureDirectory,localTarget,journalLock,ownerContext,validatePrepared};
export {importAsanaFiles} from './asana-import-files.mjs';
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)(process.argv[2]==='files'?import('./asana-import-files.mjs').then(m=>m.runAsanaFilesCli(process.argv.slice(3))):process.argv.includes('--help')?Promise.resolve(process.stdout.write('Reusable import: node scripts/import-asana-project.mjs files --help\nLegacy explicit operator: --plan|--apply --workspace-id UUID --source-project-id GID --json FILE --csv FILE --mapping PRIVATE_JSON --journal-dir DIR\n')):main()).catch(error=>{process.stderr.write('Asana operator stopped: '+(error.code?`${error.code}: ${error.message}${error.details?` ${JSON.stringify(error.details)}`:''}`:error.message)+'\n');process.exitCode=1;});
