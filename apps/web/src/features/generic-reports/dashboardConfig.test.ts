import { describe, expect, it } from 'vitest';
import { dashboardSums } from './dashboardConfig';
import { definition, plan, fact } from './test/fixtures';

describe('read-only manager dashboard measures',()=>{
 it('adds a full actual Sum without mutating the saved definition or substituting paired actual',()=>{
  const saved=definition().config,next=dashboardSums(saved);
  expect(saved.measures).toEqual([{key:'budget',operation:'sum',fieldId:plan.id}]);
  expect(next.config.measures).toEqual([{key:'budget',operation:'sum',fieldId:plan.id},{key:'dashboard_fact',operation:'sum',fieldId:fact.id}]);
  expect(next.config.filters).toEqual(saved.filters);expect(next.limited).toBe(false);
 });
 it('preserves every user measure at the 12-measure boundary and reports that a sum cannot be added',()=>{
  const saved={...definition().config,measures:Array.from({length:12},(_,i)=>({key:`count_${i}`,operation:'count_tasks' as const}))};
  const next=dashboardSums(saved);expect(next.config.measures).toEqual(saved.measures);expect(next.limited).toBe(true);
 });
 it('uses stable IDs and a unique read-only key; an existing average never substitutes for a sum',()=>{
  const saved={...definition().config,measures:[{key:'dashboard_fact',operation:'avg' as const,fieldId:fact.id},{key:'budget',operation:'sum' as const,fieldId:plan.id}]};
  const next=dashboardSums(saved);expect(next.config.measures[2]).toEqual({key:'dashboard_fact_',operation:'sum',fieldId:fact.id});
  expect(dashboardSums(next.config).config.measures).toEqual(next.config.measures);
 });
});
