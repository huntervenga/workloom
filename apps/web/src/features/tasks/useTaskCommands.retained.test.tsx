import { act, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { alpha, anna, boris } from '../../test/fakeApi';
import { protectedDraftsFor } from '../../lib/protectedDrafts';
import { protectedCommandsFor } from '../../lib/protectedCommands';
import { renderFieldUi } from '../fields/test/fixtures';
import { task } from '../planning/test/fixtures';
import { draftFromTask, emptyDraft } from './taskDraft';
import { useTaskCommands, type EditSession, type TaskCommands } from './useTaskCommands';
const dirty = (title = 'Retained title'): EditSession => ({ base: task, draft: { ...draftFromTask(task), title } });
function unload(){const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;}
function example() {
 const owners = new Map<string,TaskCommands>();
 function Owner({id,actor=anna.id,workspace=alpha.id}:{id:string;actor?:string;workspace?:string}) { const commands=useTaskCommands(actor,workspace);owners.set(id,commands);return null; }
 function Example(){const [first,setFirst]=useState(true);const [actor,setActor]=useState(anna.id);const [workspace,setWorkspace]=useState(alpha.id);return <>{first?<Owner id="first" actor={actor} workspace={workspace}/>:null}<Owner id="second"/><button onClick={()=>setFirst(false)}>Unmount first owner</button><button onClick={()=>setActor(boris.id)}>Change first actor</button><button onClick={()=>setWorkspace('b0000000-0000-4000-8000-000000000099')}>Change first workspace</button></>;}
 const ui=renderFieldUi(<Example/>);
 const get=(id='first')=>{const c=owners.get(id);if(!c)throw new Error('Missing owner');return c;};
 return {...ui,get};
}
describe('real task command owner draft protection',()=>{
 it('covers same-turn mutations and clears neither another draft nor another owner on deletion/unmount',async()=>{
  const ui=example();const first=ui.get();const second=ui.get('second');
  act(()=>{first.editSessions.current.set(task.id,dirty());expect(protectedDraftsFor(ui.client).protecting).toBe(true);expect(unload()).toBe(true);});
  act(()=>{second.editSessions.current.set(task.id,dirty('Other owner'));first.editSessions.current.clear();expect(unload()).toBe(true);});
  await ui.user.click(screen.getByRole('button',{name:'Unmount first owner'}));expect(protectedDraftsFor(ui.client).protecting).toBe(true);expect(unload()).toBe(true);
  act(()=>{second.editSessions.current.clear();expect(protectedDraftsFor(ui.client).protecting).toBe(false);expect(unload()).toBe(false);});
  expect(protectedCommandsFor(ui.client).protecting).toBe(false);
 });
 it('confirms only the submitted identity and keeps an independent edit/create draft protected',()=>{
  const ui=example();const commands=ui.get();const submitted=dirty();const replacement=dirty('Independent replacement');
  act(()=>{commands.editSessions.current.set(task.id,submitted);commands.editSessions.current.set(task.id,replacement);commands.createSession.current={request:{sectionId:null,parent:null},draft:{...emptyDraft(task.statusId,null),title:'Independent create'},workScope:'detail'};});
  act(()=>{expect(commands.confirmSession(submitted,{...task,title:submitted.draft.title,revision:2})).toBe(true);expect(commands.editSessions.current.get(task.id)).toBe(replacement);expect(unload()).toBe(true);expect(commands.confirmSession(submitted,task)).toBe(false);});
  act(()=>{commands.confirmSession(replacement,{...task,title:replacement.draft.title,revision:3});expect(unload()).toBe(true);commands.createSession.current=null;expect(unload()).toBe(false);});
 });
 it.each(['actor','workspace'] as const)('disposes an old %s owner slot without releasing the other current owner',async identity=>{
  const ui=example();const old=ui.get();const other=ui.get('second');
  act(()=>{old.editSessions.current.set(task.id,dirty());other.editSessions.current.set(task.id,dirty('Other scope'));});
  await ui.user.click(screen.getByRole('button',{name:identity==='actor'?'Change first actor':'Change first workspace'}));
  expect(ui.get().editSessions.current.size).toBe(0);expect(unload()).toBe(true);
  act(()=>{other.editSessions.current.clear();expect(unload()).toBe(false);old.editSessions.current.set('late',dirty('Detached old callback'));expect(unload()).toBe(false);expect(protectedDraftsFor(ui.client).protecting).toBe(false);});
 });
});
