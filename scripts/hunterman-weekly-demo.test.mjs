import test from 'node:test';
import assert from 'node:assert/strict';
import { FIXTURE, dryRun, stableDemoId, newJournalCommand, validateJournalCommand } from './bootstrap-hunterman-weekly-demo.mjs';

test('offline fixture has five40h personal plans,30 originals and32 distinct tasks',()=>{
 assert.equal(FIXTURE.people.length,5);assert.equal(FIXTURE.tasks.length,30);assert.equal(new Set([...FIXTURE.tasks,...FIXTURE.lateTasks].map(t=>t.key)).size,32);
 for(const p of FIXTURE.people)assert.equal(FIXTURE.tasks.filter(t=>t.person===p.key).reduce((n,t)=>n+t.plannedMinutes,0),2400);
 assert.equal(dryRun().oracle.personalOriginalPlannedMinutes,12000);
});
test('genuine completed zero is recorded, while the sole missing fact belongs to unfinished work',()=>{
 const all=[...FIXTURE.tasks,...FIXTURE.lateTasks];assert.equal(all.filter(t=>t.actualMinutes===null).length,1);
 for(const t of all.filter(t=>t.statusGroup==='done'))assert.notEqual(t.actualMinutes,null);
 assert.equal(all.find(t=>t.key==='maya-6').actualMinutes,0);assert.equal(all.find(t=>t.actualMinutes===null).statusGroup,'todo');
});
test('single categories account for11985min including540 uncategorized; overlapping tags do not change shares',()=>{
 const sums={};for(const t of [...FIXTURE.tasks,...FIXTURE.lateTasks])if(t.actualMinutes!==null)sums[t.category??'Uncategorized']=(sums[t.category??'Uncategorized']??0)+t.actualMinutes;
 assert.deepEqual(sums,{Business:3270,Bugfix:1380,Sales:2040,Management:2055,Uncategorized:540,Development:2700});
 assert.equal(Object.values(sums).reduce((n,v)=>n+v,0),11985);assert.deepEqual(sums,FIXTURE.oracle.categoryMinutes);
 assert.ok(FIXTURE.tasks.some(t=>t.tags.length>1));assert.equal(FIXTURE.lateTasks.find(t=>t.beforeFreeze).plannedMinutes,null);
});
test('fixture IDs are stable per workspace but never collide across targets',()=>{
 const one=stableDemoId('5eed0000-0000-4000-8000-000000000001','fixture:maya');assert.equal(one,stableDemoId('5EED0000-0000-4000-8000-000000000001','fixture:maya'));
 assert.notEqual(one,stableDemoId('5eed0000-0000-4000-8000-000000000002','fixture:maya'));assert.match(one,/^[0-9a-f-]{36}$/);
});

test('journal preserves original arguments rather than retargeting a retry to a fresh revision',()=>{
 const ws='5eed0000-0000-4000-8000-000000000001';const entry=newJournalCommand(ws,'columns','owner','fields','updateProjectColumns',['project',{expectedRevision:0,columns:[]}]);
 assert.deepEqual(validateJournalCommand(entry,ws,'columns','owner','fields','updateProjectColumns'),['project',{expectedRevision:0,columns:[]}]);
 entry.args[1].expectedRevision=1;assert.throws(()=>validateJournalCommand(entry,ws,'columns','owner','fields','updateProjectColumns'),/COMMAND_JOURNAL_ARGS_CHANGED/);
});
test('journal rejects changed operation key, label or actor before any domain command',()=>{
 const ws='5eed0000-0000-4000-8000-000000000001';const entry=newJournalCommand(ws,'project','owner','tasks','createProject',[{name:'Demo'}]);
 assert.throws(()=>validateJournalCommand({...entry,key:stableDemoId(ws,'different')},ws,'project','owner','tasks','createProject'),/COMMAND_JOURNAL_DRIFT/);
 assert.throws(()=>validateJournalCommand(entry,ws,'project','maya','tasks','createProject'),/COMMAND_JOURNAL_DRIFT/);
 assert.throws(()=>validateJournalCommand({...entry,label:'other'},ws,'project','owner','tasks','createProject'),/COMMAND_JOURNAL_DRIFT/);
});
