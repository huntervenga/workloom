import { describe, expect, it } from 'vitest';
import { categoryColor } from './categoryColors';
import { field } from '../fields/test/fixtures';
const source = {...field('Category','single_select'), options:[{id:'91000000-0000-4000-8000-000000000001',name:'Same label',color:'#DB2777',position:0,revision:1,archivedAt:null}]};
const option=source.options[0];if(!option)throw Error('Missing category option fixture');
describe('stored report category colors',()=>{
 it('uses project/field/option identity and normalizes only the stored HEX value',()=>{expect(categoryColor([source],source.projectId,source.id,option.id)).toBe('#db2777');expect(categoryColor([source],source.projectId,source.id,'unknown')).toBeNull();expect(categoryColor([source],'another-project',source.id,option.id)).toBeNull();});
 it('preserves color through renaming/reordering and supports multi-select options',()=>{const changed={...source,type:'multi_select' as const,options:[{...option,name:'Renamed',position:8,color:'#ffffff'}]};expect(categoryColor([changed],source.projectId,source.id,option.id)).toBe('#ffffff');});
 it('keeps missing, removed and invalid colors as an explicit fallback',()=>{for(const color of [null,'red','url(bad)','#fff']) expect(categoryColor([{...source,options:[{...option,color}]}],source.projectId,source.id,option.id)).toBeNull();expect(categoryColor([source],source.projectId,null,option.id)).toBeNull();});
});
