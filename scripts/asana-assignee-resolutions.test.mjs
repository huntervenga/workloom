import test from 'node:test';
import assert from 'node:assert/strict';
import {listAssignees,applyAssigneeResolutions} from './asana-assignee-resolutions.mjs';

const task=(gid,name,extra={})=>({gid,name,notes:'',completed:false,resource_subtype:'default_task',workspace:{gid:'9'},memberships:[{project:{gid:'7',name:'P'},section:null}],subtasks:[],...extra});
const json=JSON.stringify({data:[
 task('1','Parent A',{subtasks:[task('2','Child of A',{parent:{gid:'1',name:'Parent A'}})]}),
 task('3','Parent B'),
]});
const csv='Task ID,Name,Assignee,Assignee Email,Parent task,Blocked By (Dependencies)\n1,Parent A,Ann,ann@x.test,,\n2,Child of A,Bob,bob@x.test,Parent A,\n3,Parent B,Bob,bob@x.test,,Parent A\n';

test('lists people with task counts',()=>{
 assert.deepEqual(listAssignees(json,csv),[{email:'ann@x.test',name:'Ann',taskCount:1},{email:'bob@x.test',name:'Bob',taskCount:2}]);
});
test('unassign clears the assignee in both files and keeps the tasks',()=>{
 const out=applyAssigneeResolutions(json,csv,{'bob@x.test':{action:'unassign'}});
 assert.equal(out.unassigned,2);
 assert.ok(!out.csvText.includes('bob@x.test'));
 assert.equal(JSON.parse(out.jsonText).data[1].assignee,null);
});
test('skip drops the tasks, promotes their children and removes dependencies on them',()=>{
 const out=applyAssigneeResolutions(json,csv,{'ann@x.test':{action:'skip'}});
 assert.equal(out.skipped,1);
 const data=JSON.parse(out.jsonText).data;
 assert.deepEqual(data.map(t=>t.gid),['2','3']);
 const lines=out.csvText.trim().split('\n');
 assert.equal(lines.length,3);
 assert.ok(!/Parent A/.test(lines[2]),'the dependency on the skipped task is gone');
});
test('no decisions leaves the files untouched; unknown actions are refused',()=>{
 assert.equal(applyAssigneeResolutions(json,csv,{}).csvText,csv);
 assert.throws(()=>applyAssigneeResolutions(json,csv,{'ann@x.test':{action:'x'}}));
});

test('leaves chosen task ids out and promotes their subtasks, without any assignee decision',()=>{
 const out=applyAssigneeResolutions(json,csv,{},['1']);
 const data=JSON.parse(out.jsonText).data;
 assert.deepEqual(data.map(t=>t.gid),['2','3']);
 assert.equal(out.csvText.split('\n').filter(Boolean).length,3);
 assert.ok(!out.csvText.includes('Parent A,ann@x.test'));
 assert.equal(out.skipped,1);
});

test('a subtask listed inside a skipped parent and on its own is kept once',()=>{
 const child=task('12','Child',{parent:{gid:'11',name:'Parent'}});
 const dupJson=JSON.stringify({data:[task('11','Parent',{subtasks:[child]}),child]});
 const dupCsv='Task ID,Name,Assignee,Assignee Email,Parent task,Blocked By (Dependencies)\n11,Parent,Bob,bob@x.test,,\n12,Child,,,Parent,\n';
 const out=applyAssigneeResolutions(dupJson,dupCsv,{'bob@x.test':{action:'skip'}});
 const gids=[];const visit=list=>{for(const t of list){gids.push(t.gid);visit(t.subtasks)}};visit(JSON.parse(out.jsonText).data);
 assert.deepEqual(gids,['12']);
});

test('a nested subtask also listed on its own is kept once when a middle task is skipped and its parent is kept',()=>{
 const deep=task('23','Deep',{parent:{gid:'22',name:'Middle'}});
 const dupJson=JSON.stringify({data:[task('21','Root',{subtasks:[task('22','Middle',{parent:{gid:'21',name:'Root'},subtasks:[deep]})]}),deep]});
 const dupCsv='Task ID,Name,Assignee,Assignee Email,Parent task,Blocked By (Dependencies)\n21,Root,,,,\n22,Middle,Bob,bob@x.test,Root,\n23,Deep,,,Middle,\n';
 const out=applyAssigneeResolutions(dupJson,dupCsv,{'bob@x.test':{action:'skip'}});
 const gids=[];const visit=list=>{for(const t of list){gids.push(t.gid);visit(t.subtasks)}};visit(JSON.parse(out.jsonText).data);
 assert.deepEqual([...gids].sort(),['21','23']);
});
