import { describe, expect, it } from 'vitest';
import type { GenericMeasureResultDto, PersonalEffortResultDto } from '@workloom/contracts';
import { comparisonOperation, hasPersonalEffort } from './effortAttribution';
import { dashboardSums } from './dashboardConfig';
import { personMetrics } from './dashboardMetrics';
import { workTypeDistribution } from './workTypeDistribution';
import { amount, coverage, definition, fact, plan, result } from './test/fixtures';

function required<T>(value:T|undefined):T{if(value===undefined)throw Error('fixture');return value;}
const person='a1000000-0000-4000-8000-000000000001', category='a1000000-0000-4000-8000-000000000002';
function effort(keys:string[], minutes:number):PersonalEffortResultDto {
 return {minutes,canonicalTaskCount:1,participationCount:keys.length,coverage:{sources:keys.length,known:keys.length,unknown:0,zero:0,void:0},contributions:keys.map(sourceKey=>({sourceKey,sourceKind:'shared_attendance',taskId:person,membershipId:person,fieldId:fact.id,minutes:minutes/keys.length,state:'value',sourceRevision:1,activityRevision:1,occurrenceDate:'2026-10-20',category:null}))};
}
const metric=(key:string,fieldId:string,value:number,operation:'sum'|'personal_effort'):GenericMeasureResultDto=>({key,fieldId,operation,unit:'minutes',value:amount(value),coverage:{...coverage,tasks:1,filled:1,missing:0,null:0,zero:0}});
it('keeps existing sums task-based and explicitly adds participant measures only for a personal comparison',()=>{
 const saved=definition().config;if(!saved.comparison)throw Error('fixture');
 expect(comparisonOperation(saved)).toBe('sum');expect(hasPersonalEffort(saved)).toBe(false);
 const selected={...saved,comparison:{...saved.comparison,attribution:'personal_effort' as const}};
 const augmented=dashboardSums(selected);
 expect(augmented.config.measures).toEqual([...saved.measures,{key:'dashboard_plan',operation:'personal_effort',fieldId:plan.id},{key:'dashboard_fact',operation:'personal_effort',fieldId:fact.id}]);
 expect(saved.measures).toEqual([{key:'budget',operation:'sum',fieldId:plan.id}]);
 expect(dashboardSums(augmented.config).config).toEqual(augmented.config);
});
it('uses authoritative personal totals rather than an earlier event SUM or loaded rows',()=>{
 const base=result();if(!base.config.comparison)throw Error('fixture');
 const report={...base,config:{...base.config,groupBy:{kind:'assignee' as const},comparison:{...base.config.comparison,attribution:'personal_effort' as const}},groups:[{key:person,label:'One person',taskCount:2,comparison:null,initialComparison:null,measures:[metric('event',fact.id,60,'sum'),metric('planned',plan.id,180,'personal_effort'),metric('recorded',fact.id,210,'personal_effort')]}]};
 expect(personMetrics(report)[0]).toMatchObject({plan:amount(180),fact:amount(210),taskCount:2});
 expect(personMetrics({...report,groups:[{...required(report.groups[0]),measures:[metric('event',fact.id,60,'sum')]}]})[0]?.fact).toBeNull();
});
describe('personal effort category partition',()=>{
 function source(){const base=result();if(!base.config.comparison)throw Error('fixture');const m={...metric('effort',fact.id,120,'personal_effort'),coverage:{tasks:2,filled:2,missing:0,null:0,zero:0},effort:effort(['one','two'],120)};
 return {...base,totalTasks:1,attribution:'personal_effort' as const,config:{...base.config,measures:[{key:'effort',operation:'personal_effort' as const,fieldId:fact.id}],comparison:{...base.config.comparison,attribution:'personal_effort' as const},groupBy:{kind:'category' as const,fieldId:category},filters:{...base.config.filters,assignee:{kind:'member' as const,membershipId:person}}},measures:[m],groups:[{key:'first',label:'A',taskCount:1,comparison:null,initialComparison:null,measures:[{...m,value:amount(60),coverage:{...m.coverage,tasks:1,filled:1},effort:effort(['one'],60)}]},{key:'uncategorized',label:'Uncategorized',taskCount:1,comparison:null,initialComparison:null,measures:[{...m,value:amount(60),coverage:{...m.coverage,tasks:1,filled:1},effort:effort(['two'],60)}]}]};}
 it('allows one canonical call in two categories only when contribution sources partition exactly',()=>{const report=source(),pie=workTypeDistribution(report,fact.id,category);expect(pie.state).toBe('ready');expect(pie.items.map(item=>item.percentText)).toEqual(['50%','50%']);});
 it('refuses duplicate source identities even when displayed totals and counts match',()=>{const report=source();required(required(report.groups[1]).measures[0]).effort=effort(['one'],60);expect(workTypeDistribution(report,fact.id,category).state).toBe('inconsistent');});
});
