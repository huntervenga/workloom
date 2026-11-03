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
 let unassigned=0;const newParent=new Map(),promoted=new Set();
 // Drop skipped tasks; their kept children move up to the nearest kept ancestor (or become top-level tasks).
 const rebuild=(tasks,kept,top=true)=>{
  const out=[];
  for(const t of tasks??[]){
   if(skip.has(t.gid)){const moved=rebuild(t.subtasks,kept,false);for(const child of moved)promoted.add(child);out.push(...moved);continue;}
   if(decided.get(t.gid)==='unassign'){t.assignee=null;unassigned+=1;}
   if(kept&&t.parent?.gid!==kept.gid){t.parent={...t.parent,gid:kept.gid,name:kept.name};newParent.set(t.gid,kept.name);}
   // A child promoted to the top level must still belong to the imported project, without a section of its own.
   if(!kept&&top===false)t.memberships=[{project:{gid:projectId,name:projectName,resource_type:'project'},section:null}];
   t.subtasks=rebuild(t.subtasks,t,true);out.push(t);
  }
  return out;
 };
 data.data=rebuild(data.data,null);
 // A task the export lists in more than one place (inside its parent and on its own) must not appear twice once a skipped
 // ancestor made it move up. The plan reader treats a nested entry as the real one and ignores a top-level copy whose parent
 // is in the export, so: the moved copy stays, and the old top-level copy (whose parent is now gone) is dropped.
 {const movedGids=new Set([...promoted].map(t=>t.gid)),top=new Set(data.data);
  const stale=t=>top.has(t)&&!promoted.has(t)&&movedGids.has(t.gid)&&skip.has(t.parent?.gid);
  data.data=data.data.filter(t=>!stale(t));
  const plain=new Set(),collect=list=>{for(const t of list??[]){if(!promoted.has(t))plain.add(t.gid);collect(t.subtasks);}};collect(data.data);
  const seen=new Set(),prune=list=>{const kept=[];for(const t of list??[]){if(promoted.has(t)&&(plain.has(t.gid)||seen.has(t.gid)))continue;if(promoted.has(t))seen.add(t.gid);t.subtasks=prune(t.subtasks);kept.push(t);}return kept;};data.data=prune(data.data);}
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

/** Tags of the export (gid → name), as the JSON lists them on its tasks and subtasks. */
export function listExportTags(jsonText){
 const tags=new Map();
 walk(JSON.parse(jsonText.replace(/^\ufeff/,'')).data,t=>{for(const tag of t.tags??[])if(tag?.gid&&typeof tag.name==='string')tags.set(String(tag.gid),tag.name);});
 return tags;
}

/**
 * Takes the given tags (by gid) off every task in both files, so the importer sees an export in which they never existed.
 * The Tags column of the CSV holds names, so exactly the names of the removed tags are taken out of each cell.
 * Returns the removed names in first-seen order.
 */
export function removeTags(jsonText,csvText,gids){
 const wanted=new Set([...gids].map(String));
 if(wanted.size===0)return {jsonText,csvText,removed:[]};
 const data=JSON.parse(jsonText.replace(/^\ufeff/,'')),names=new Map();
 walk(data.data,t=>{if(!Array.isArray(t.tags))return;t.tags=t.tags.filter(tag=>{if(wanted.has(String(tag?.gid))){names.set(String(tag.gid),tag.name);return false;}return true;});});
 const dropped=new Set(names.values());
 const records=parseCsvRecords(csvText),headers=records.shift(),col=headers.indexOf('Tags');
 const rows=records.map(row=>{
  if(col<0||!row[col])return row;
  const copy=[...row];copy[col]=row[col].split(',').filter(name=>!dropped.has(name.trim())).join(',');return copy;
 });
 return {jsonText:JSON.stringify(data),csvText:[headers,...rows].map(r=>r.map(quote).join(',')).join('\n')+'\n',removed:[...names.values()]};
}
