import {and,asc,eq,gt,isNull,or,sql} from 'drizzle-orm';
import type {TaskProjectPlacementDto} from '@workloom/contracts';
import {DomainError,notFoundError,type TaskProjectPlacementRepository} from '@workloom/domain';
import {isDatabase,type Database,type WorkloomExecutor} from '../client.js';
import {taskProjectPlacements as placements,tasks} from '../schema.js';
function dto(row:typeof placements.$inferSelect):TaskProjectPlacementDto {return {...row,createdAt:row.createdAt.toISOString(),updatedAt:row.updatedAt.toISOString(),archivedAt:row.archivedAt?.toISOString()??null};}
const MAX_TRANSFER_TASKS=500;
const blocked=(message:string,reason:string):never=>{throw new DomainError('DOMAIN_VALIDATION_FAILED',message,{details:{fields:['taskId'],transferReason:reason}});};
const SELECT_TYPES=new Set(['single_select','multi_select']);
interface TreeTask {id:string;project_id:string;status_id:string;section_id:string|null;position:number;work_package_id:string;depth:number}
const uuidArray=(values:readonly string[])=>sql`${'{'+values.join(',')+'}'}::uuid[]`;

/**
 * Re-homes one task tree in the open write transaction. Everything that carries the project in its key moves in one
 * statement (the foreign keys are checked at its end); the former home placement is kept as a detached placement so the
 * immutable history of its field values keeps its anchor. Anything bound to the old project's accounting that this
 * command cannot move safely blocks the transfer with a plain reason instead of being rewritten.
 */
async function transferTree(db:WorkloomExecutor,plan:{workspaceId:string;taskId:string;targetProjectId:string;sectionId:string|null|undefined;now:string}) {
 const ws=plan.workspaceId,target=plan.targetProjectId,now=plan.now;
 const rows=<T>(result:unknown)=>result as T[];
 const tree=rows<TreeTask>(await db.execute(sql`
  with recursive tree as (
   select id, 0 as depth from tasks where workspace_id=${ws} and id=${plan.taskId}
   union all
   select t.id, tree.depth+1 from tasks t join tree on t.parent_task_id=tree.id where t.workspace_id=${ws} and tree.depth<50)
  select t.id::text id, t.project_id::text project_id, t.status_id::text status_id, t.section_id::text section_id, t.position, t.work_package_id::text work_package_id, tree.depth
  from tree join tasks t on t.workspace_id=${ws} and t.id=tree.id order by tree.depth, t.position, t.id`));
 const root=tree[0];if(!root)throw notFoundError();
 const home=root.project_id;if(home===target)blocked('The task is already in this project.','same_project');
 if(tree.length>MAX_TRANSFER_TASKS)blocked(`The task has more than ${MAX_TRANSFER_TASKS} subtasks; move it in parts.`,'too_many');
 const ids=tree.map(task=>task.id),packages=[...new Set(tree.map(task=>task.work_package_id))],taskIds=uuidArray(ids),packageIds=uuidArray(packages);
 const count=async(query:ReturnType<typeof sql>):Promise<number>=>Number(rows<{n:string}>(await db.execute(query))[0]?.n??0);
 // Anything tied to the old project's accounting is left alone, so the task must be free of it.
 const tied:[string,string,ReturnType<typeof sql>][]=[
  ['planned hours (commitments)','plans',sql`select count(*) n from commitment_allocations where workspace_id=${ws} and task_id=any(${taskIds})`],
  ['recorded work (work logs)','work_logs',sql`select count(*) n from work_logs where workspace_id=${ws} and (task_id=any(${taskIds}) or work_package_id=any(${packageIds}))`],
  ['a frozen plan or baseline','baseline',sql`select (select count(*) from planning_locks where workspace_id=${ws} and (task_id=any(${taskIds}) or work_package_id=any(${packageIds})))+(select count(*) from package_baselines where workspace_id=${ws} and work_package_id=any(${packageIds}))+(select count(*) from package_freeze_observations where workspace_id=${ws} and work_package_id=any(${packageIds}))+(select count(*) from period_commitments where workspace_id=${ws} and work_package_id=any(${packageIds})) n`],
  ['a meeting or recurring series','meeting',sql`select (select count(*) from meetings where workspace_id=${ws} and (task_id=any(${taskIds}) or work_package_id=any(${packageIds})))+(select count(*) from meeting_attendances where workspace_id=${ws} and task_id=any(${taskIds}))+(select count(*) from recurrence_instances where workspace_id=${ws} and (task_id=any(${taskIds}) or work_package_id=any(${packageIds})))+(select count(*) from shared_activities where workspace_id=${ws} and task_id=any(${taskIds})) n`],
  ['a work package shared with tasks that are not moving','shared_package',sql`select count(*) n from tasks where workspace_id=${ws} and work_package_id=any(${packageIds}) and id<>all(${taskIds})`],
  ['a split or replaced work package','split_package',sql`select count(*) n from work_packages where workspace_id=${ws} and ((id=any(${packageIds}) and source_package_id is not null and source_package_id<>all(${packageIds})) or (source_package_id=any(${packageIds}) and id<>all(${packageIds})))`],
 ];
 for(const [label,reason,query] of tied)if(await count(query)>0)blocked(`This task is tied to its project by ${label}. Resolve that first; nothing was changed.`,reason);
 // The one-project rule is about the whole moving tree: a subtask that is still placed elsewhere blocks it as well.
 if(await count(sql`select count(*) n from project_rules where workspace_id=${ws} and project_id=${target} and config->>'singleProject'='true'`)>0
  &&await count(sql`select count(*) n from task_project_placements where workspace_id=${ws} and task_id=any(${taskIds}) and archived_at is null and project_id<>home_project_id and project_id<>${target}`)>0)
  blocked('This project keeps every task in one project only, and a task or subtask is still placed in other projects. Remove it from them first.','single_project');
 // Statuses: the same name in the same group, else the first status of the group.
 const sourceStatus=rows<{id:string;name:string;grp:string}>(await db.execute(sql`select id::text id, name, "group"::text grp from task_statuses where workspace_id=${ws} and project_id=${home}`));
 const targetStatus=rows<{id:string;name:string;grp:string}>(await db.execute(sql`select id::text id, name, "group"::text grp from task_statuses where workspace_id=${ws} and project_id=${target} order by position, id`));
 const statusOf=new Map<string,string>();
 for(const status of sourceStatus){const peers=targetStatus.filter(item=>item.grp===status.grp);const pick=peers.find(item=>item.name.trim().toLowerCase()===status.name.trim().toLowerCase())??peers[0];if(pick)statusOf.set(status.id,pick.id);}
 if(tree.some(task=>!statusOf.has(task.status_id)))blocked('The target project has no status in the same group as one of the task statuses.','no_status');
 // Sections: by name; a section chosen for the task itself wins for the task itself.
 const sourceSections=rows<{id:string;name:string}>(await db.execute(sql`select id::text id, name from sections where workspace_id=${ws} and project_id=${home}`));
 const targetSections=rows<{id:string;name:string}>(await db.execute(sql`select id::text id, name from sections where workspace_id=${ws} and project_id=${target} and archived_at is null`));
 const sectionByName=(id:string|null):string|null=>{if(id===null)return null;const name=sourceSections.find(item=>item.id===id)?.name.trim().toLowerCase();return name===undefined?null:targetSections.find(item=>item.name.trim().toLowerCase()===name)?.id??null;};
 const [first]=rows<{base:number}>(await db.execute(sql`select greatest((select coalesce(max(position),-1) from tasks where workspace_id=${ws} and project_id=${target}),(select coalesce(max(position),-1) from task_project_placements where workspace_id=${ws} and project_id=${target}))+1 as base`));
 const base=Number(first?.base??0);
 const moves=tree.map((task,index)=>({id:task.id,status_id:statusOf.get(task.status_id) as string,section_id:task.id===root.id&&plan.sectionId!==undefined?plan.sectionId:sectionByName(task.section_id),position:base+index}));
 // Placements that already exist in the target (a detached one from an earlier stay) become the new home row.
 const inTarget=new Set(rows<{task_id:string}>(await db.execute(sql`select task_id::text task_id from task_project_placements where workspace_id=${ws} and project_id=${target} and task_id=any(${taskIds})`)).map(row=>row.task_id));
 const json=JSON.stringify(moves.map(move=>({...move,has_target:inTarget.has(move.id)})));
 // One statement re-homes everything that carries the project in its key; the placement identity guard is open only
 // around it, and the primary key is checked at its end so the two placements can swap which one has the task's id.
 await db.execute(sql`set constraints "task_project_placements_pkey" deferred`);
 await db.execute(sql`select set_config('workloom.task_transfer','on',true)`);
 await db.execute(sql`
  with m as (select * from jsonb_to_recordset(${json}::jsonb) as x(id uuid, status_id uuid, section_id uuid, position integer, has_target boolean)),
  wp as (update work_packages set project_id=${target}, revision=revision+1, updated_at=${now}::timestamptz where workspace_id=${ws} and id=any(${packageIds}) returning id),
  t as (update tasks set project_id=${target}, status_id=m.status_id, section_id=m.section_id, position=m.position, revision=tasks.revision+1, updated_at=${now}::timestamptz
        from m where tasks.workspace_id=${ws} and tasks.id=m.id returning tasks.id),
  pl as (update task_project_placements p set
          id=case when p.project_id=${home} then gen_random_uuid() when p.project_id=${target} then p.task_id else p.id end,
          archived_at=case when p.project_id=${home} then ${now}::timestamptz when p.project_id=${target} then null else p.archived_at end,
          section_id=case when p.project_id=${target} then m.section_id else p.section_id end,
          position=case when p.project_id=${target} then m.position else p.position end,
          home_project_id=${target}, revision=p.revision+1, updated_at=${now}::timestamptz
         from m where p.workspace_id=${ws} and p.task_id=m.id returning p.id),
  ins as (insert into task_project_placements(id, workspace_id, task_id, home_project_id, project_id, section_id, position, revision, created_at, updated_at)
          select m.id, ${ws}, m.id, ${target}, ${target}, m.section_id, m.position, 1, ${now}::timestamptz, ${now}::timestamptz from m where not m.has_target returning id)
  select (select count(*) from t) as moved, (select count(*) from pl) as replaced, (select count(*) from ins) as created, (select count(*) from wp) as packages`);
 await db.execute(sql`select set_config('workloom.task_transfer','',true)`);
 await db.execute(sql`set constraints "task_project_placements_pkey" immediate`);
 // The guard did not check the home rows inside the window; check them now, so a bad state can never commit.
 const bad=await count(sql`select count(*) n from tasks t where t.workspace_id=${ws} and t.id=any(${taskIds}) and (
   (select count(*) from task_project_placements p where p.workspace_id=t.workspace_id and p.task_id=t.id and p.project_id=t.project_id and p.id=t.id and p.archived_at is null and p.section_id is not distinct from t.section_id and p.position=t.position)<>1
   or exists (select 1 from task_project_placements p where p.workspace_id=t.workspace_id and p.task_id=t.id and p.home_project_id<>t.project_id))`);
 if(bad>0)throw new Error('Task transfer left an inconsistent home placement.');
 // Values that have a matching field (same name and type) in the target are returned for the command to write through
 // the shared field primitive (locks, policies, history); the rest stays with the detached placement.
 const sourceFields=rows<{id:string;name:string;type:string}>(await db.execute(sql`select id::text id, name, type::text type from task_field_definitions where workspace_id=${ws} and project_id=${home}`));
 const targetFields=rows<{id:string;name:string;type:string;version:string}>(await db.execute(sql`select id::text id, name, type::text type, definition_version_id::text version from task_field_definitions where workspace_id=${ws} and project_id=${target} and archived_at is null`));
 const options=rows<{id:string;field_id:string;name:string;archived:boolean}>(await db.execute(sql`select id::text id, field_id::text field_id, name, (archived_at is not null) archived from task_field_options where workspace_id=${ws} and project_id in (${home},${target})`));
 const fieldKey=(name:string,type:string)=>name.trim().toLowerCase()+'\u0000'+type;
 const targetOf=new Map(targetFields.map(field=>[fieldKey(field.name,field.type),field]));
 const mappedField=new Map<string,{id:string;version:string;name:string;type:string}>();
 for(const field of sourceFields){const match=targetOf.get(fieldKey(field.name,field.type));if(match)mappedField.set(field.id,{id:match.id,version:match.version,name:field.name,type:field.type});}
 const optionTarget=(sourceOptionId:string,sourceFieldId:string,targetFieldId:string):string|null=>{
  const label=options.find(item=>item.id===sourceOptionId&&item.field_id===sourceFieldId)?.name.trim().toLowerCase();
  return label===undefined?null:options.find(item=>item.field_id===targetFieldId&&!item.archived&&item.name.trim().toLowerCase()===label)?.id??null;
 };
 const values=rows<{task_id:string;field_id:string;field_type:string;value:{value:unknown}}>(await db.execute(sql`select task_id::text task_id, field_id::text field_id, field_type::text field_type, value from task_field_values where workspace_id=${ws} and project_id=${home} and task_id=any(${taskIds})`));
 const carried:{taskId:string;fieldId:string;fieldName:string;value:{type:string;value:unknown}}[]=[],lost=new Map<string,number>();
 for(const row of values){
  const source=sourceFields.find(field=>field.id===row.field_id),mapped=mappedField.get(row.field_id);
  const lose=()=>{const name=source?.name??'?';lost.set(name,(lost.get(name)??0)+1);};
  if(!mapped){lose();continue;}
  let next:unknown=row.value.value;
  // An explicit clear (null) is a value too: it carries over, so a stale value of an earlier stay cannot come back.
  if(next!==null&&SELECT_TYPES.has(row.field_type)){
   if(row.field_type==='single_select'){const option=typeof next==='string'?optionTarget(next,row.field_id,mapped.id):null;if(option===null){lose();continue;}next=option;}
   else{const mappedOptions=(Array.isArray(next)?next:[]).map(item=>typeof item==='string'?optionTarget(item,row.field_id,mapped.id):null);if(mappedOptions.some(item=>item===null)||mappedOptions.length===0){lose();continue;}next=mappedOptions;}
  }
  carried.push({taskId:row.task_id,fieldId:mapped.id,fieldName:mapped.name,value:{type:row.field_type,value:next}});
 }
 return {movedTaskIds:ids,values:carried,notCarried:[...lost].map(([fieldName,n])=>({fieldName,count:n})).sort((x,y)=>x.fieldName.localeCompare(y.fieldName))};
}

export function createTaskProjectPlacementRepository(source:Database|WorkloomExecutor):TaskProjectPlacementRepository {
 const db:WorkloomExecutor=isDatabase(source)?source.db:source;
 return {
  transferTree:plan=>transferTree(db,plan),
  async find(ws,id){const [row]=await db.select().from(placements).where(and(eq(placements.workspaceId,ws),eq(placements.id,id)));return row?dto(row):null;},
  async findForTaskProject(ws,taskId,projectId){const [row]=await db.select().from(placements).where(and(eq(placements.workspaceId,ws),eq(placements.taskId,taskId),eq(placements.projectId,projectId)));return row?dto(row):null;},
  async listForTask(ws,taskId,take){return (await db.select().from(placements).where(and(eq(placements.workspaceId,ws),eq(placements.taskId,taskId))).orderBy(asc(placements.projectId),asc(placements.id)).limit(take)).map(dto);},
  async listProject(ws,projectId,includeArchived,after,take){
   if(after!==null&&!('position' in after))throw new Error('Project placement pages require position cursors.');
   return (await db.select({placement:placements}).from(placements).innerJoin(tasks,and(eq(tasks.workspaceId,placements.workspaceId),eq(tasks.id,placements.taskId))).where(and(eq(placements.workspaceId,ws),eq(placements.projectId,projectId),includeArchived?undefined:and(isNull(placements.archivedAt),isNull(tasks.archivedAt)),after===null?undefined:or(gt(placements.position,after.position),and(eq(placements.position,after.position),gt(placements.id,after.id))))).orderBy(asc(placements.position),asc(placements.id)).limit(take)).map(row=>dto(row.placement));
  },
  async maxPosition(ws,projectId){const [row]=await db.select({max:sql<number>`coalesce(max(${placements.position}), -1)::integer`}).from(placements).where(and(eq(placements.workspaceId,ws),eq(placements.projectId,projectId)));return row?.max??-1;},
  async insert(row){await db.insert(placements).values({...row,archivedAt:row.archivedAt===null?null:new Date(row.archivedAt),createdAt:new Date(row.createdAt),updatedAt:new Date(row.updatedAt)});},
  async save(row){const updated=await db.update(placements).set({sectionId:row.sectionId,position:row.position,revision:row.revision,archivedAt:row.archivedAt===null?null:new Date(row.archivedAt),updatedAt:new Date(row.updatedAt)}).where(and(eq(placements.workspaceId,row.workspaceId),eq(placements.id,row.id),eq(placements.revision,row.revision-1))).returning({id:placements.id});if(updated.length!==1)throw notFoundError();},
 };
}
