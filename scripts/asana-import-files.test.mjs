import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareAsanaPlan,parseSourceCsv} from './import-asana-project.mjs';
import {discoverAsanaSource,validateReusableOptions} from './asana-import-files.mjs';
import {syntheticSource} from './import-asana-project.test-fixture.mjs';
const ws='aaaaaaaa-0000-4000-8000-000000000001',member='aaaaaaaa-0000-4000-8000-000000000002';
const encode=rows=>rows.map(row=>row.map(v=>'"'+String(v).replaceAll('"','""')+'"').join(',')).join('\r\n')+'\r\n';
test('source discovery requires the common root project rather than a filename or first incidental placement',()=>{
 const src=syntheticSource(ws,member),j=JSON.parse(src.jsonText);assert.equal(discoverAsanaSource(src.jsonText).sourceProjectId,'200');
 j.data.forEach(t=>t.memberships.push({project:{gid:'201',name:'Another project'},section:null}));assert.throws(()=>discoverAsanaSource(JSON.stringify(j)),/ambiguous/);assert.equal(discoverAsanaSource(JSON.stringify(j),'201').sourceProjectId,'201');assert.throws(()=>discoverAsanaSource(JSON.stringify(j),'202'),/ambiguous/);
});
test('milestone conversion and unresolved external dependency preservation are explicit, retained and counted',()=>{
 const src=syntheticSource(ws,member),j=JSON.parse(src.jsonText),csv=parseSourceCsv(src.csvText);j.data[0].resource_subtype='milestone';
 assert.throws(()=>prepareAsanaPlan({...src,jsonText:JSON.stringify(j),workspaceId:ws}),/explicit preserve_as_task/);
 const mapping={...src.mapping,unsupportedSubtypePolicy:'preserve_as_task',unresolvedDependencyPolicy:'preserve'};csv.rows[1]['Blocked By (Dependencies)']='External source task without ID';
 const plan=prepareAsanaPlan({...src,jsonText:JSON.stringify(j),csvText:encode([csv.headers,...csv.rows.map(r=>csv.headers.map(h=>r[h]))]),mapping,workspaceId:ws});assert.equal(plan.tasks.length,105);assert.equal(plan.summary.provenanceOnly.milestonesPreservedAsOrdinaryTasks,1);assert.equal(plan.summary.provenanceOnly.unresolvedExternalDependencies,1);assert.equal(plan.tasks[0].provenance.originalTask.resource_subtype,'milestone');assert.equal(plan.tasks[1].provenance.originalCsv['Blocked By (Dependencies)'],'External source task without ID');assert.equal(plan.dependencies.length,1);
});
test('optional report bindings and all date/hierarchy inputs reject before command execution',async()=>{
 const src=syntheticSource(ws,member),base=prepareAsanaPlan({...src,workspaceId:ws}),plan={...base,adapterVersion:2,importOptions:{projectDates:{from:'2026-10-12',to:'2026-10-18'},report:{name:'Delivery',hierarchy:'root_tasks',capacityRange:{startDate:'2026-10-12',endDate:'2026-10-18'}}}};
 await assert.doesNotReject(validateReusableOptions(plan));await assert.rejects(validateReusableOptions({...plan,importOptions:{...plan.importOptions,projectDates:{from:'2026-10-18',to:'2026-10-12'}}}));await assert.rejects(validateReusableOptions({...plan,importOptions:{report:{hierarchy:'guess_week'}}}));await assert.rejects(validateReusableOptions({...plan,fields:[],importOptions:{report:{}}}),/explicitly mapped/);await assert.rejects(validateReusableOptions({...plan,importOptions:{report:{capacityRange:{startDate:'2026-10-12',endDate:'2029-10-18'}}}}));
});

test('discovery rejects oversized/deep/malformed input and unsafe project IDs before downstream I/O',()=>{
 const root={gid:'1',workspace:{gid:'2'},memberships:[{project:{gid:'3'}}],subtasks:[]};
 assert.throws(()=>discoverAsanaSource('null'),/nonempty/);
 assert.throws(()=>discoverAsanaSource(JSON.stringify({data:[null]})),/task object/);
 assert.throws(()=>discoverAsanaSource(JSON.stringify({data:[{...root,subtasks:{}}]})),/array/);
 assert.throws(()=>discoverAsanaSource(JSON.stringify({data:Array(2001).fill(root)})),/2000/);
 assert.throws(()=>discoverAsanaSource(JSON.stringify({data:[{...root,memberships:[{project:{gid:'../../escape'}}]}]})),/decimal/);
 // Construct directly: JSON.stringify itself is recursive and cannot generate an adversarial deep tree.
 const deep='{"data":['+'{"subtasks":['.repeat(10000)+'{}'+']}'.repeat(10000)+']}';
 assert.throws(()=>discoverAsanaSource(deep),e=>!(e instanceof RangeError)&&/too deep/.test(e.message));
 assert.throws(()=>discoverAsanaSource(' '.repeat(10485761)),/bounds/);
});

test('same-name source fields cannot silently lose a conflicting populated value',()=>{
 const src=syntheticSource(ws,member),j=JSON.parse(src.jsonText),task=j.data[1],original=task.custom_fields[0];
 // This root has an explicit zero, which must not be treated as absent.
 assert.equal(original.number_value,0);
 task.custom_fields.push({...original,gid:'799',number_value:2});
 assert.throws(()=>prepareAsanaPlan({...src,jsonText:JSON.stringify(j),workspaceId:ws}),/Conflicting populated same-name/);
 task.custom_fields.at(-1).number_value=0;
 assert.equal(prepareAsanaPlan({...src,jsonText:JSON.stringify(j),workspaceId:ws}).tasks[1].values['701'],0);
 task.custom_fields.at(-1).number_value=null;
 assert.doesNotThrow(()=>prepareAsanaPlan({...src,jsonText:JSON.stringify(j),workspaceId:ws}));
});
