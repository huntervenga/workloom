import { act, screen, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { alpha, anna, deferred, installFakeApi, json,ok } from '../../test/fakeApi';
import { field, FIELD_ID, renderFieldUi, STAMP } from '../fields/test/fixtures';
import { useSetTaskFieldValueMutation } from '../fields/queries';
import { task, rootPath } from '../planning/test/fixtures';
import { useTaskCommands } from './useTaskCommands';

it('drains a committed task field after a foreign protected writer acknowledges without another edit or close', async () => {
  const gate = deferred<Response>();
  const definition = field('Foreign number', 'number');
  const { calls } = installFakeApi({
    [`PUT ${rootPath}/tasks/${task.id}/field-values/${FIELD_ID}`]: () => gate.promise,
    [`PATCH ${rootPath}/tasks/${task.id}`]: () => ok({ ...task, title: 'Queued title', revision: task.revision + 1 }),
  });
  function Example() {
    const commands = useTaskCommands(anna.id, alpha.id);
    const foreign = useSetTaskFieldValueMutation(anna.id, alpha.id);
    return <>
      <button onClick={() => foreign.mutate({ taskId: task.id, fieldId: FIELD_ID, input: { expectedRevision: 0, expectedDefinitionRevision: definition.revision, value: { type: 'number', value: 7 } } })}>Start foreign field write</button>
      <button onClick={() => { commands.autosave.authorize(task.id, true); commands.autosave.choose(task, { title: 'Queued title' }); }}>Commit task title</button>
    </>;
  }
  const ui = renderFieldUi(<Example />);
  await ui.user.click(screen.getByRole('button', { name: 'Start foreign field write' }));
  await waitFor(() => expect(calls).toHaveLength(1));
  await ui.user.click(screen.getByRole('button', { name: 'Commit task title' }));
  expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(0);
  await act(async () => gate.resolve(ok({ workspaceId: alpha.id, projectId: task.projectId, taskId: task.id, fieldId: FIELD_ID, definitionVersionId: definition.definitionVersionId, value: { type: 'number', value: 7 }, revision: 1, updatedAt: STAMP })));
  await waitFor(() => expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(1));
  expect(calls.filter(call => call.method === 'PATCH')[0]?.body).toEqual({ expectedRevision: task.revision, title: 'Queued title' });
  expect(calls.filter(call => call.method === 'PUT')).toHaveLength(1);
});

it('wires a confirmed completion prerequisite refusal to status-only recovery while the task remains editable',async()=>{
 let commands!:ReturnType<typeof useTaskCommands>;let attempts=0;
 const{calls}=installFakeApi({[`PATCH ${rootPath}/tasks/${task.id}`]:()=>++attempts===1?json(422,{error:{code:'DOMAIN_VALIDATION_FAILED',message:'private body',retryable:false,details:{policyReason:'completion_fields_required'}},meta:{requestId:'required'}}):ok({...task,title:'Still editable',revision:task.revision+1})});
 function Example(){const c=useTaskCommands(anna.id,alpha.id);commands=c;return<><button onClick={()=>{c.autosave.authorize(task.id,true);c.autosave.choose(task,{statusId:'f6000000-0000-4000-8000-000000000002'});}}>Try completing</button><button onClick={()=>c.autosave.choose(task,{title:'Still editable'})}>Repair another field</button></>;}
 const ui=renderFieldUi(<Example/>);await ui.user.click(screen.getByRole('button',{name:'Try completing'}));await waitFor(()=>expect(commands?.autosave.get(task.id)?.phase).toBe('rejected'));expect(commands?.autosave.getPaused()).toBeNull();expect(commands?.editSessions.current.has(task.id)).toBe(false);expect(commands?.autosave.get(task.id)?.draft.statusId).toBe(task.statusId);
 await ui.user.click(screen.getByRole('button',{name:'Repair another field'}));await waitFor(()=>expect(commands?.autosave.get(task.id)?.phase).toBe('saved'));expect(calls.filter(call=>call.method==='PATCH').map(call=>call.body)).toEqual([{expectedRevision:task.revision,statusId:'f6000000-0000-4000-8000-000000000002'},{expectedRevision:task.revision,title:'Still editable'}]);
});
