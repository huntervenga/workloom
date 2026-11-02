/**
 * Lets an Asana import go ahead when some assignees are not teammates of the workspace: the owner decides, per person,
 * to skip their tasks, import them unassigned, or give them to someone who is on the Members page.
 * Everything here is a pure text transformation of the two exports; the importer then sees an ordinary snapshot.
 */
import {parseCsvRecords,dependencyTargets} from './import-asana-project.mjs';
import {discoverAsanaSource} from './asana-import-files.mjs';

const ACTIONS=new Set(['skip','unassign','reassign']);
const mail=value=>typeof value==='string'?value.trim().toLowerCase():'';
const quote=cell=>/[",\r\n]/.test(cell)||cell!==cell.trim()?`"${cell.replaceAll('"','""')}"`:cell;
const walk=(tasks,visit,parent=null)=>{for(const t of tasks??[]){visit(t,parent);walk(t.subtasks,visit,t);}};

/** Everyone assigned in the export with their task count: [{email,name,taskCount}] in first-seen order. */
export function listAssignees(jsonText,csvText){
 const records=parseCsvRecords(csvText),headers=records.shift()??[],email=headers.indexOf('Assignee Email'),name=headers.indexOf('Assignee');
 const people=new Map();
 if(email<0||name<0)return [];
 for(const row of records){const key=mail(row[email]);if(!key||!row[name])continue;const entry=people.get(key)??{email:key,name:row[name],taskCount:0};entry.taskCount+=1;people.set(key,entry);}
 void jsonText;
 return [...people.values()];
}

/** Task IDs in the export, in file order (top-level and subtasks). */
export function listTaskIds(jsonText){const ids=[];walk(JSON.parse(jsonText.replace(/^\ufeff/,'')).data,t=>ids.push(t.gid));return ids;}

/**
 * skipTaskIds leaves those tasks out entirely (their kept subtasks move up), exactly like a skipped person's tasks.
 * resolutions: {[email]: {action:'skip'|'unassign'|'reassign'}}. A reassigned person keeps their name and e-mail in the files;
 * the caller maps that e-mail to the chosen teammate in the identity mapping, so nothing is rewritten here for it.
 */
export function applyAssigneeResolutions(jsonText,csvText,resolutions,skipTaskIds=[]){
 const entries=Object.entries(resolutions??{}).map(([k,v])=>[mail(k),v]);
 if(entries.length===0&&skipTaskIds.length===0)return {jsonText,csvText,skipped:0,unassigned:0};
 for(const [,v] of entries)if(!v||!ACTIONS.has(v.action))throw new Error('Unknown assignee action.');
 const by=new Map(entries),action=email=>by.get(mail(email))?.action;
 const data=JSON.parse(jsonText.replace(/^\ufeff/,''));
 const records=parseCsvRecords(csvText),headers=records.shift(),col=n=>headers.indexOf(n);
 const id=col('Task ID'),emailCol=col('Assignee Email'),nameCol=col('Assignee'),parentCol=col('Parent task'),blockedBy=col('Blocked By (Dependencies)'),blocking=col('Blocking (Dependencies)');
 // The e-mail is only in the CSV, so decisions are keyed by task id from there.
 const decided=new Map(),skip=new Set(skipTaskIds),names=new Map();
 for(const row of records){const a=action(row[emailCol]);if(a){decided.set(row[id],a);if(a==='skip')skip.add(row[id]);}}
 walk(data.data,t=>names.set(t.gid,t.name));
 const projectId=discoverAsanaSource(jsonText).sourceProjectId;let projectName='';walk(data.data,t=>{for(const m of t.memberships??[])if(m.project?.gid===projectId&&m.project.name)projectName=m.project.name;});
 let unassigned=0;const newParent=new Map(),topLevel=new Set((data.data??[]).map(t=>t.gid));
 // Drop skipped tasks; their kept children move up to the nearest kept ancestor (or become top-level tasks).
 const rebuild=(tasks,kept,top=true)=>{
  const out=[];
  for(const t of tasks??[]){
   // A subtask the export also lists on its own stays only in that own entry, so it is not added twice.
   if(!top&&!kept&&topLevel.has(t.gid))continue;
   if(skip.has(t.gid)){out.push(...rebuild(t.subtasks,kept,false));continue;}
   if(decided.get(t.gid)==='unassign'){t.assignee=null;unassigned+=1;}
   if(kept&&t.parent?.gid!==kept.gid){t.parent={...t.parent,gid:kept.gid,name:kept.name};newParent.set(t.gid,kept.name);}
   // A child promoted to the top level must still belong to the imported project, without a section of its own.
   if(!kept&&top===false)t.memberships=[{project:{gid:projectId,name:projectName,resource_type:'project'},section:null}];
   t.subtasks=rebuild(t.subtasks,t,true);out.push(t);
  }
  return out;
 };
 data.data=rebuild(data.data,null);
 const byName=new Map();for(const [gid,name] of names)byName.set(name,[...(byName.get(name)??[]),gid]);
 const rows=[];
 for(const row of records){
  const gid=row[id];if(skip.has(gid))continue;
  const copy=[...row];
  if(decided.get(gid)==='unassign'){copy[emailCol]='';copy[nameCol]='';}
  if(newParent.has(gid))copy[parentCol]=newParent.get(gid);
  // Dependencies on skipped tasks disappear with them.
  for(const c of [blockedBy,blocking]){
   if(c<0||!copy[c])continue;const targets=dependencyTargets(copy[c],byName);
   if(targets?.some(t=>skip.has(t)))copy[c]=targets.filter(t=>!skip.has(t)).map(t=>names.get(t)).join(',');
  }
  rows.push(copy);
 }
 return {jsonText:JSON.stringify(data),csvText:[headers,...rows].map(r=>r.map(quote).join(',')).join('\n')+'\n',skipped:skip.size,unassigned};
}
