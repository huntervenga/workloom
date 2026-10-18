import {useQuery} from '@tanstack/react-query';
import {workspaceResponseSchema} from '@workloom/contracts';
import {apiGet} from '../../lib/api';
import {fieldPolicyKeys} from './policy-queries';
import {act,fireEvent,screen,waitFor,within} from '@testing-library/react';
import {useState} from 'react';
import {describe,expect,it} from 'vitest';
import type {TaskFieldPolicyDto} from '@workloom/contracts';
import {queryKeys} from '../../lib/queryKeys';
import {createQueryClient} from '../../lib/queryClient';
import {alpha,alphaMembers,anna,installFakeApi,json,ok} from '../../test/fakeApi';
import {FieldPolicyPanel,localDeadlineToUtc,utcDeadlineToLocal} from './FieldPolicyPanel';
import {useSetFieldPolicyMutation} from './policy-queries';
import {FieldValueForm,newFieldSession} from './FieldValueForm';
import {useSetTaskFieldValueMutation} from './queries';
import {FIELD_ID,PROJECT_ID,STAMP,field,heldResponse,renderFieldUi} from './test/fixtures';
const TASK='f0000000-0000-4000-8000-000000000001';
const policyPath=`/api/v1/workspaces/${alpha.id}/fields/${FIELD_ID}/policy`;
const valuePath=`/api/v1/workspaces/${alpha.id}/tasks/${TASK}/field-values/${FIELD_ID}`;
const empty:TaskFieldPolicyDto={workspaceId:alpha.id,projectId:PROJECT_ID,fieldId:FIELD_ID,revision:0,lockAt:null,maxChangesPerActor:null,activatedAt:null,updatedAt:null,updatedByUserId:null};
const configured={...empty,revision:1,maxChangesPerActor:0,activatedAt:STAMP,updatedAt:STAMP,updatedByUserId:anna.id};
const definition=field('Notes');
function client(role:'owner'|'admin'='owner') {const c=createQueryClient({retry:false});c.setQueryData(queryKeys.workspace(anna.id,alpha.id),{...alpha,role});return c;}
function RulesHarness() {
  const mutation=useSetFieldPolicyMutation(anna.id,alpha.id),[show,setShow]=useState(true);
  return <><button onClick={()=>setShow(!show)}>Toggle rules panel</button>{show?<FieldPolicyPanel actorId={anna.id} workspaceId={alpha.id} field={definition} mutation={mutation}/>:null}</>;
}
function ValueHarness() {
  // The actual page owns an active workspace root observer. A policy refusal invalidates that
  // current permission read; a cache-only fixture would correctly remain unverified forever.
  useQuery({queryKey:queryKeys.workspace(anna.id,alpha.id),queryFn:async({signal})=>(await apiGet(`/api/v1/workspaces/${alpha.id}`,workspaceResponseSchema,signal)).data,staleTime:Infinity});
  const mutation=useSetTaskFieldValueMutation(anna.id,alpha.id),[show,setShow]=useState(true);
  const [session,setSession]=useState(()=>newFieldSession(definition,null));
  return <><button onClick={()=>setShow(true)}>Open value</button>{show?<FieldValueForm actorId={anna.id} workspaceId={alpha.id} taskId={TASK} taskTitle="Policy task" session={session} currentField={definition} currentValue={null} members={alphaMembers} writable mutation={mutation} blockedNotice={null} onSessionChange={setSession} onDiscard={()=>setSession(newFieldSession(definition,null))} onReload={async()=>({field:definition,value:null})} onFieldLocked={()=>{}} onClose={()=>setShow(false)} autosave/>:null}</>;
}

describe('field rule owner controls',()=>{
  it('converts strictly in the viewer zone and rejects normalized invalid local dates',()=>{
    const local='2030-06-12T14:35',expected=new Date(2030,5,12,14,35,0,0).toISOString();
    expect(localDeadlineToUtc(local)).toBe(expected);expect(utcDeadlineToLocal(expected)).toBe(local);
    for(const invalid of ['2030-02-30T14:35','2030-13-12T14:35','2030-06-12T24:35','2030-06-12T14:60','2030-06-12 14:35'])expect(()=>localDeadlineToUtc(invalid)).toThrow();
    expect(localDeadlineToUtc('')).toBeNull();
  });
  it('sends zero as a real limit with the current policy revision and UTC deadline',async()=>{
    let remote=empty;
    const {calls}=installFakeApi({['GET '+policyPath]:()=>ok(remote),['PUT '+policyPath]:(request)=>{const input=request.body as {lockAt:string;maxChangesPerActor:number};remote={...configured,...input};return ok(remote);}});
    const {user}=renderFieldUi(<RulesHarness/>,client());
    await user.click(screen.getByText('Rules'));
    const limit=await screen.findByLabelText('Maximum changes per person, task and field');
    fireEvent.change(limit,{target:{value:'0'}});
    const timezone=Intl.DateTimeFormat().resolvedOptions().timeZone;
    fireEvent.change(screen.getByLabelText(`Stop changes after (${timezone})`),{target:{value:'2030-06-12T14:35'}});
    await user.click(screen.getByRole('button',{name:'Save rules'}));
    await waitFor(()=>expect(calls.filter(c=>c.method==='PUT')).toHaveLength(1));
    expect(calls.find(c=>c.method==='PUT')?.body).toEqual({expectedRevision:0,lockAt:new Date(2030,5,12,14,35).toISOString(),maxChangesPerActor:0});
  });
  it('retains an unknown rules body/key through remount and requires exact owner, not admin',async()=>{
    const gate=heldResponse();let attempt=0,remote=empty;
    const {calls}=installFakeApi({['GET '+policyPath]:()=>ok(remote),['PUT '+policyPath]:()=>{remote=configured;return ++attempt===1?gate.promise:ok(configured);}});
    const {user}=renderFieldUi(<RulesHarness/>,client());await user.click(screen.getByText('Rules'));
    fireEvent.change(await screen.findByLabelText('Maximum changes per person, task and field'),{target:{value:'0'}});
    await user.click(screen.getByRole('button',{name:'Save rules'}));await waitFor(()=>expect(attempt).toBe(1));
    await act(async()=>gate.lose());
    await user.click(screen.getByRole('button',{name:'Toggle rules panel'}));await user.click(screen.getByRole('button',{name:'Toggle rules panel'}));
    expect(await screen.findByLabelText('Maximum changes per person, task and field')).toBeDisabled();
    await user.click(await screen.findByRole('button',{name:'Retry same rules update'}));
    await waitFor(()=>expect(attempt).toBe(2));
    await waitFor(()=>expect(screen.queryByText('Rules changed while you were editing. Your draft and its original revision are kept.')).not.toBeInTheDocument());
    const writes=calls.filter(c=>c.method==='PUT');expect(writes[1]?.body).toEqual(writes[0]?.body);expect(writes[1]?.headers.get('idempotency-key')).toBe(writes[0]?.headers.get('idempotency-key'));
  });
  it('shows admin a readable policy without owner controls',async()=>{
    const {calls}=installFakeApi({['GET '+policyPath]:()=>ok(configured)});
    const {user}=renderFieldUi(<RulesHarness/>,client('admin'));await user.click(screen.getByText('Rules'));
    expect(await screen.findByLabelText('Maximum changes per person, task and field')).toBeDisabled();
    expect(screen.getByText('Only the workspace owner can change these rules.')).toBeInTheDocument();expect(screen.queryByRole('button',{name:'Save rules'})).not.toBeInTheDocument();
    expect(calls.filter(c=>c.method!=='GET')).toHaveLength(0);
  });
});

describe('field rule refusals and one-shot exception ownership',()=>{
  it('keeps a blocked draft, sends only explicit exception, and retries its original reason/body/key after close',async()=>{
    const gate=heldResponse();let attempts=0;
    const {calls}=installFakeApi({['GET '+valuePath+'/policy-state']:()=>ok({policy:configured,currentActorChangesUsed:0}),['POST '+valuePath+'/exception']:()=>{attempts++;return gate.promise;}});
    const {user}=renderFieldUi(<ValueHarness/>,client());
    await user.click(await screen.findByRole('button',{name:'Make owner exception'}));
    const dialog=screen.getByRole('dialog');fireEvent.change(within(dialog).getByRole('textbox',{name:'Notes'}),{target:{value:'Correction'}});
    fireEvent.change(within(dialog).getByLabelText('Reason for this exception'),{target:{value:'Source correction'}});
    await user.click(within(dialog).getByLabelText('Close',{selector:'button'}));
    expect(calls.filter(c=>c.method!=='GET')).toHaveLength(0);
    await user.click(screen.getByRole('button',{name:'Open value'}));
    await user.click(screen.getByRole('button',{name:'Apply exception once'}));await waitFor(()=>expect(attempts).toBe(1));
    await act(async()=>gate.lose());
    await user.click(screen.getByLabelText('Close',{selector:'button'}));await user.click(screen.getByRole('button',{name:'Open value'}));
    await user.click(await screen.findByRole('button',{name:'Retry'}));
    await waitFor(()=>expect(attempts).toBe(2));
    const writes=calls.filter(c=>c.method==='POST');expect(writes[0]?.body).toEqual({expectedRevision:0,expectedDefinitionRevision:1,expectedPolicyRevision:1,value:{type:'text',value:'Correction'},reason:'Source correction'});
    expect(writes[1]?.body).toEqual(writes[0]?.body);expect(writes[1]?.headers.get('idempotency-key')).toBe(writes[0]?.headers.get('idempotency-key'));
    expect(calls.filter(c=>c.method==='PUT')).toHaveLength(0);
  });
  it('refreshes a deadline reached while open, keeps the unsent value, and never resends on close',async()=>{
    let policy=empty;
    const {calls}=installFakeApi({['GET '+valuePath+'/policy-state']:()=>ok({policy,currentActorChangesUsed:0}),['GET /api/v1/workspaces/'+alpha.id]:()=>ok({...alpha,role:'owner'}),['PUT '+valuePath]:()=>{policy={...configured,lockAt:'2020-01-01T00:00:00.000Z'};return json(409,{error:{code:'FIELD_LOCKED',message:'Deadline reached',retryable:false,details:{policyReason:'deadline'}},meta:{requestId:'policy-test'}});}});
    const {user}=renderFieldUi(<ValueHarness/>,client());
    const input=await screen.findByRole('textbox',{name:'Notes'});fireEvent.change(input,{target:{value:'Unsent after deadline'}});fireEvent.blur(input);
    await screen.findByText('The field deadline has passed. Your unsent value is kept.');
    expect(input).toHaveValue('Unsent after deadline');expect(input).toBeDisabled();
    expect(await screen.findByRole('button',{name:'Make owner exception'})).toBeInTheDocument();
    await user.click(screen.getByLabelText('Close',{selector:'button'}));
    expect(calls.filter(c=>c.method==='PUT')).toHaveLength(1);
  });
});


describe('absolute field refusals remain absolute in the owner editor',()=>{
  it('does not offer a quota exception after a baseline FIELD_LOCKED without a rule classification',async()=>{
    let policy=empty;
    const {calls}=installFakeApi({['GET '+valuePath+'/policy-state']:()=>ok({policy,currentActorChangesUsed:0}),['GET /api/v1/workspaces/'+alpha.id]:()=>ok({...alpha,role:'owner'}),['PUT '+valuePath]:()=>{policy=configured;return json(409,{error:{code:'FIELD_LOCKED',message:'Immutable baseline',retryable:false,details:{committed:true,baselineIds:['11111111-1111-4111-8111-111111111111']}},meta:{requestId:'baseline-test'}});}});
    const {user}=renderFieldUi(<ValueHarness/>,client());
    const input=await screen.findByRole('textbox',{name:'Notes'});fireEvent.change(input,{target:{value:'Kept behind absolute lock'}});fireEvent.blur(input);
    await screen.findByText('You have used 0 of 0 changes for this task field. Your unsent value is kept.');
    expect(input).toHaveValue('Kept behind absolute lock');expect(input).toBeDisabled();
    expect(screen.queryByRole('button',{name:'Make owner exception'})).not.toBeInTheDocument();expect(screen.queryByRole('button',{name:'Apply exception once'})).not.toBeInTheDocument();
    await user.click(screen.getByLabelText('Close',{selector:'button'}));expect(calls.filter(c=>c.method==='PUT')).toHaveLength(1);expect(calls.filter(c=>c.method==='POST')).toHaveLength(0);
  });
});


describe('explicit exception intent never falls back to autosave',()=>{
  it('keeps reason and value readonly through owner renewal and role loss without sending an ordinary command',async()=>{
    const {calls}=installFakeApi({['GET '+valuePath+'/policy-state']:()=>ok({policy:configured,currentActorChangesUsed:0})});
    const queryClient=client(),{user}=renderFieldUi(<ValueHarness/>,queryClient);
    await user.click(await screen.findByRole('button',{name:'Make owner exception'}));
    const input=screen.getByRole('textbox',{name:'Notes'});fireEvent.change(input,{target:{value:'Owner correction intent'}});
    fireEvent.change(screen.getByLabelText('Reason for this exception'),{target:{value:'Keep this reason'}});
    await act(async()=>{
      await queryClient.invalidateQueries({queryKey:queryKeys.workspace(anna.id,alpha.id),exact:true,refetchType:'none'});
      queryClient.setQueryData(fieldPolicyKeys.state(anna.id,alpha.id,TASK,FIELD_ID),{policy:{...configured,maxChangesPerActor:null},currentActorChangesUsed:0});
    });
    expect(screen.getByLabelText('Reason for this exception')).toHaveValue('Keep this reason');expect(input).toBeDisabled();
    fireEvent.blur(input);await user.click(screen.getByLabelText('Close',{selector:'button'}));
    expect(calls.filter(c=>c.method!=='GET')).toHaveLength(0);
    await act(async()=>{queryClient.setQueryData(queryKeys.workspace(anna.id,alpha.id),{...alpha,role:'member'});});
    await user.click(screen.getByRole('button',{name:'Open value'}));
    expect(screen.getByRole('textbox',{name:'Notes'})).toHaveValue('Owner correction intent');
    expect(screen.getByLabelText('Reason for this exception')).toHaveValue('Keep this reason');expect(screen.getByLabelText('Reason for this exception')).toBeDisabled();
    await user.click(screen.getByLabelText('Close',{selector:'button'}));expect(calls.filter(c=>c.method!=='GET')).toHaveLength(0);
  });
});


describe('policy draft revision ownership',()=>{
  it('keeps typed quota and original revision through a background change, then replaces only on explicit reload',async()=>{
    const newer={...configured,revision:7,maxChangesPerActor:7};
    const {calls}=installFakeApi({['GET '+policyPath]:()=>ok(empty),['PUT '+policyPath]:()=>json(409,{error:{code:'REVISION_CONFLICT',message:'Changed rules',retryable:false},meta:{requestId:'policy-stale'}})});
    const queryClient=client(),{user}=renderFieldUi(<RulesHarness/>,queryClient);await user.click(screen.getByText('Rules'));
    const input=await screen.findByLabelText('Maximum changes per person, task and field');fireEvent.change(input,{target:{value:'2'}});
    await act(async()=>{queryClient.setQueryData(fieldPolicyKeys.policy(anna.id,alpha.id,FIELD_ID),newer);});
    expect(input).toHaveValue('2');await screen.findByText('Rules changed while you were editing. Your draft and its original revision are kept.');
    await user.click(screen.getByRole('button',{name:'Save rules'}));await waitFor(()=>expect(calls.filter(c=>c.method==='PUT')).toHaveLength(1));
    expect(calls.find(c=>c.method==='PUT')?.body).toEqual({expectedRevision:0,lockAt:null,maxChangesPerActor:2});
    expect(input).toHaveValue('2');
    await user.click(screen.getByRole('button',{name:'Replace draft with current rules'}));expect(input).toHaveValue('7');
  });
  it('preserves invalid numeric text and never interprets a partial number as unlimited',async()=>{
    const {calls}=installFakeApi({['GET '+policyPath]:()=>ok(configured)});
    const {user}=renderFieldUi(<RulesHarness/>,client());await user.click(screen.getByText('Rules'));
    const input=await screen.findByLabelText('Maximum changes per person, task and field');
    for(const raw of ['-','1e','3.5']) {
      fireEvent.change(input,{target:{value:raw}});await user.click(screen.getByRole('button',{name:'Save rules'}));
      expect(input).toHaveValue(raw);expect(calls.filter(c=>c.method!=='GET')).toHaveLength(0);
    }
  });
});


describe('same-mounted policy unknown command completion',()=>{
  it('accepts its exact retry ACK as the new clean base without a false stale-draft notice',async()=>{
    let remote=empty,attempts=0;const gate=heldResponse();
    const {calls}=installFakeApi({['GET '+policyPath]:()=>ok(remote),['PUT '+policyPath]:()=>{remote={...configured,maxChangesPerActor:2};return ++attempts===1?gate.promise:ok(remote);}});
    const queryClient=client(),{user}=renderFieldUi(<RulesHarness/>,queryClient);await user.click(screen.getByText('Rules'));
    fireEvent.change(await screen.findByLabelText('Maximum changes per person, task and field'),{target:{value:'2'}});
    await user.click(screen.getByRole('button',{name:'Save rules'}));await waitFor(()=>expect(attempts).toBe(1));await act(async()=>gate.lose());
    await user.click(await screen.findByRole('button',{name:'Retry same rules update'}));
    await waitFor(()=>expect(queryClient.getQueryData<TaskFieldPolicyDto>(fieldPolicyKeys.policy(anna.id,alpha.id,FIELD_ID))?.revision).toBe(1));
    expect(screen.getByLabelText('Maximum changes per person, task and field')).toHaveValue('2');
    expect(screen.queryByText('Rules changed while you were editing. Your draft and its original revision are kept.')).not.toBeInTheDocument();
    const writes=calls.filter(c=>c.method==='PUT');expect(writes).toHaveLength(2);expect(writes[1]?.body).toEqual(writes[0]?.body);expect(writes[1]?.headers.get('idempotency-key')).toBe(writes[0]?.headers.get('idempotency-key'));
  });
});
