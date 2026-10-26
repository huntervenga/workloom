import type {TaskStatusDto} from '@workloom/contracts';
import {act,screen,waitFor,within} from '@testing-library/react';
import {useState} from 'react';
import {describe,expect,it,vi} from 'vitest';
import {alpha,alphaMembers,anna,deferred,installFakeApi,json} from '../../test/fakeApi';
import {renderFieldUi} from '../fields/test/fixtures';
import {rootPath,task} from '../planning/test/fixtures';
import {InlineTaskEdit} from './InlineTaskEdit';
import {draftFromTask} from './taskDraft';
import {useTaskCommands,type EditSession,type TaskCommands} from './useTaskCommands';
const done='f6000000-0000-4000-8000-000000000002',progress='f6000000-0000-4000-8000-000000000003';
const statuses:TaskStatusDto[]=[{id:task.statusId,name:'Current todo',group:'todo'},{id:done,name:'Complete',group:'done'},{id:progress,name:'Newer progress',group:'in_progress'}].map((row,position)=>({...row,workspaceId:task.workspaceId,projectId:task.projectId,revision:1,position})) as TaskStatusDto[];
const refusal=()=>json(422,{error:{code:'DOMAIN_VALIDATION_FAILED',message:'Untrusted field text',retryable:false,details:{policyReason:'completion_fields_required'}},meta:{requestId:'inline-required'}});
function setup(){
 let current!:TaskCommands;const onSaved=vi.fn(),replacement:EditSession={base:task,draft:{...draftFromTask(task),statusId:progress},inlineField:'statusId'};
 function Example(){const commands=useTaskCommands(anna.id,alpha.id);current=commands;const[open,setOpen]=useState(true),[key,setKey]=useState(0);return<>{open?<InlineTaskEdit key={key} task={task} field="statusId" statuses={statuses} members={alphaMembers} commands={commands} writable onClose={()=>setOpen(false)} onMoreDetails={()=>undefined} onSaved={onSaved}/>:null}<button onClick={()=>setOpen(false)}>Hide editor</button><button onClick={()=>{commands.editSessions.current.set(task.id,replacement);setKey(n=>n+1);setOpen(true);}}>Open newer status draft</button></>;}
 return{...renderFieldUi(<Example/>),commands:()=>current,onSaved,replacement};
}
describe('confirmed completion prerequisite in inline status',()=>{
 it('restores only its own submitted status, keeps a readable refusal and releases field editing',async()=>{
  installFakeApi({[`PATCH ${rootPath}/tasks/${task.id}`]:refusal});const ui=setup();await ui.user.click(within(screen.getByRole('listbox',{name:'Status'})).getByRole('option',{name:'Complete'}));await screen.findByText('Could not close the task');await waitFor(()=>expect(screen.getByRole('combobox',{name:'Status'})).toHaveTextContent('Current todo'));expect(ui.commands().editSessions.current.has(task.id)).toBe(false);expect(ui.onSaved).not.toHaveBeenCalled();expect(screen.queryByText('Untrusted field text')).not.toBeInTheDocument();
 });
 it('does not apply an old qualifying error to a newly opened different status draft',async()=>{
  installFakeApi({[`PATCH ${rootPath}/tasks/${task.id}`]:refusal});const ui=setup();await ui.user.click(within(screen.getByRole('listbox',{name:'Status'})).getByRole('option',{name:'Complete'}));await screen.findByText('Could not close the task');await ui.user.click(screen.getByRole('button',{name:'Open newer status draft'}));expect(screen.getByRole('combobox',{name:'Status'})).toHaveTextContent('Newer progress');expect(ui.commands().editSessions.current.get(task.id)).toBe(ui.replacement);expect(ui.onSaved).not.toHaveBeenCalled();
 });
 it('retains a replacement session when the older submitted completion refusal arrives late',async()=>{
  const gate=deferred<Response>();installFakeApi({[`PATCH ${rootPath}/tasks/${task.id}`]:()=>gate.promise});const ui=setup();await ui.user.click(within(screen.getByRole('listbox',{name:'Status'})).getByRole('option',{name:'Complete'}));await waitFor(()=>expect(ui.commands().update.pendingCommand).not.toBeNull());await ui.user.click(screen.getByRole('button',{name:'Hide editor'}));await ui.user.click(screen.getByRole('button',{name:'Open newer status draft'}));await act(async()=>gate.resolve(refusal()));await screen.findByText('Could not close the task');expect(screen.getByRole('combobox',{name:'Status'})).toHaveTextContent('Newer progress');expect(ui.commands().editSessions.current.get(task.id)).toBe(ui.replacement);expect(ui.onSaved).not.toHaveBeenCalled();
 });
});
