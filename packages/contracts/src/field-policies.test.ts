import {describe,expect,it} from 'vitest';
import {setTaskFieldPolicyInputSchema,setTaskFieldValueExceptionInputSchema,setTaskFieldValueInputSchema} from './index.js';

describe('separate field rule command contracts',()=>{
  it('preserves the exact ordinary value body without policy defaults',()=>{
    const body={expectedRevision:0,expectedDefinitionRevision:1,value:{type:'text',value:null}};
    expect(setTaskFieldValueInputSchema.parse(body)).toEqual(body);
    expect(setTaskFieldValueInputSchema.safeParse({...body,reason:'bypass'}).success).toBe(false);
  });
  it('distinguishes zero from unlimited and rejects negative quotas and non-UTC dates',()=>{
    expect(setTaskFieldPolicyInputSchema.parse({expectedRevision:0,lockAt:null,maxChangesPerActor:0}).maxChangesPerActor).toBe(0);
    expect(setTaskFieldPolicyInputSchema.safeParse({expectedRevision:0,lockAt:null,maxChangesPerActor:-1}).success).toBe(false);
    expect(setTaskFieldPolicyInputSchema.safeParse({expectedRevision:0,lockAt:'2026-10-18T12:30',maxChangesPerActor:null}).success).toBe(false);
  });
  it('requires a bounded explicit exception reason and current policy revision',()=>{
    const body={expectedRevision:0,expectedDefinitionRevision:1,value:{type:'text',value:'corrected'}};
    expect(setTaskFieldValueExceptionInputSchema.safeParse({...body,reason:'Correction'}).success).toBe(false);
    expect(setTaskFieldValueExceptionInputSchema.safeParse({...body,expectedPolicyRevision:0,reason:'  '}).success).toBe(false);
    expect(setTaskFieldValueExceptionInputSchema.safeParse({...body,expectedPolicyRevision:0,reason:'x'.repeat(501)}).success).toBe(false);
    expect(setTaskFieldValueExceptionInputSchema.parse({...body,expectedPolicyRevision:0,reason:'  Source correction  '}).reason).toBe('Source correction');
  });
});
