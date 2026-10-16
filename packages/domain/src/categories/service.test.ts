import type {CategorizedWorkLogDto,WorkCategorySnapshot,WorkTypeReportRowDto} from '@workloom/contracts';
import {describe,expect,it} from 'vitest';
import {workTypeBuckets} from './service.js';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const category=(option:number,revision:number,label:string):WorkCategorySnapshot=>({kind:'categorized',bindingVersionId:id(10),bindingRevision:2,fieldId:id(11),fieldDefinitionVersionId:id(100+revision),fieldLabel:'Work type',optionId:id(option),optionRevision:revision,optionLabel:label,color:null,optionArchivedAt:null});
const uncategorized:WorkCategorySnapshot={kind:'uncategorized',reason:'legacy',bindingVersionId:null,bindingRevision:null,fieldId:null};
function row(n:number,minutes:number,cat:WorkCategorySnapshot,seq:string,state:'active'|'void'='active'):WorkTypeReportRowDto{
 const workLog:CategorizedWorkLogDto={id:id(n+1000),workspaceId:id(1),projectId:id(2),taskId:id(n+2000),workPackageId:id(3),membershipId:id(4),periodId:id(5),sourceKind:'manual_period',sourceKey:`${id(n+2000)}:${id(4)}:${id(5)}`,precision:'period',revision:1,revisionId:id(n),minutes,state,reason:null,actorUserId:id(6),recordedAt:'2026-10-16T00:00:00.000Z',changeSeq:seq,category:cat};
 return {id:id(n),workLog,taskTitle:'Task',memberName:'Member',excluded:state==='void'};
}
describe('pinned category distribution',()=>{
 it('keeps uncategorized minutes in the denominator and excludes void revisions',()=>{
  const rows=[row(1,60,category(20,1,'A'),'1'),row(2,30,category(21,1,'B'),'2'),row(3,30,uncategorized,'3'),row(4,999,category(20,1,'A'),'4','void')];
  const buckets=workTypeBuckets(rows);
  expect(buckets.map(b=>({label:b.label,minutes:b.minutes,share:b.sharePercent}))).toEqual([{label:'A',minutes:60,share:50},{label:'B',minutes:30,share:25},{label:'Без категории',minutes:30,share:25}]);
  expect(buckets.reduce((a,b)=>a+b.minutes,0)).toBe(120);
 });
 it('never lets a later hours correction restore an older observed option label',()=>{
  const oldCorrected=row(1,120,category(20,1,'Old label'),'100');
  const renamedSource=row(2,30,category(20,2,'New label'),'9');
  expect(workTypeBuckets([oldCorrected,renamedSource])[0]).toMatchObject({label:'New label',minutes:150,sharePercent:100});
  expect(oldCorrected.workLog.category).toMatchObject({optionLabel:'Old label',optionRevision:1});
 });
 it('uses numeric change sequence within the same option revision and deterministic revision ID ties',()=>{
  const a=row(1,10,category(20,2,'At nine'),'9'),b=row(2,10,category(20,2,'At ten'),'10');
  expect(workTypeBuckets([a,b])[0]?.label).toBe('At ten');
  const c=row(3,10,category(20,2,'Deterministic tie'),'10');
  expect(workTypeBuckets([b,c])[0]?.label).toBe('Deterministic tie');
  expect(workTypeBuckets([c,b])[0]?.label).toBe('Deterministic tie');
 });
 it('keeps active zero distinct from no source without inventing percentages',()=>{
  expect(workTypeBuckets([])).toEqual([]);
  expect(workTypeBuckets([row(1,0,category(20,1,'Known zero'),'1')])).toEqual([expect.objectContaining({label:'Known zero',minutes:0,sharePercent:null})]);
  expect(workTypeBuckets([row(1,0,uncategorized,'1','void')])).toEqual([]);
 });
});
