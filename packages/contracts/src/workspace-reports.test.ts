import {describe,it,expect} from 'vitest';
import {workspaceReportQueryInputSchema} from './workspace-reports.js';
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const input={sources:[{reportId:id(1),expectedRevision:1}],range:{from:'2026-01-01',to:'2026-12-31'},bucket:'month',people:{kind:'all_active'},dateSource:'due_date'};
describe('workspace report contracts',()=>{
 it('supplies explicit independent hierarchy/comparison defaults without any planning period',()=>{expect(workspaceReportQueryInputSchema.parse(input)).toMatchObject({hierarchy:'all_tasks',completion:'done_only'});});
 it('allows explicit category IDs and trusted uppercase ID normalization',()=>{expect(workspaceReportQueryInputSchema.parse({...input,sources:[{reportId:id(1).toUpperCase(),expectedRevision:1,categoryFieldId:id(2)}]}).sources[0]?.categoryFieldId).toBe(id(2));});
 it.each([{range:{from:'2026-12-31',to:'2026-01-01'}},{range:{from:'2026-01-01',to:'2027-01-02'}},{range:{from:'1800-01-01',to:'1800-02-01'}},{sources:[]},{sources:[{reportId:id(1),expectedRevision:1},{reportId:id(1),expectedRevision:2}]},{sources:Array.from({length:21},(_,i)=>({reportId:id(i+1),expectedRevision:1}))},{actorUserId:id(8)},{periodId:id(9)},{people:{kind:'selected',membershipIds:[]}}])('rejects unsupported or ambiguous scope %j',patch=>{expect(workspaceReportQueryInputSchema.safeParse({...input,...patch}).success).toBe(false);});
});
