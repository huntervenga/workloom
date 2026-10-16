import {describe,it,expect} from 'vitest';
import {projectImportMappingSchema,isImportStringSafe} from './imports.js';
const id='00000000-0000-4000-8000-000000000001';
const base={externalIdColumn:0,titleColumn:1,defaultStatusId:id,dateFormat:'iso',shareableScopeConfirmed:true,people:[],statuses:[],sections:[],tags:[],customFields:[],preserveColumns:[]};
describe('import canonical mapping',()=>{
 it('sorts canonically distinct Unicode source strings independent of input order/ICU collation',()=>{const people=[{sourceValue:'é',membershipId:id},{sourceValue:'e\u0301',membershipId:id}];expect(projectImportMappingSchema.parse({...base,people})).toEqual(projectImportMappingSchema.parse({...base,people:[...people].reverse()}));});
 it('rejects core/custom/preserved column overlap',()=>{for(const value of [{...base,titleColumn:0},{...base,preserveColumns:[1]},{...base,customFields:[{column:1,fieldId:id,expectedDefinitionRevision:1,empty:'missing',sourceMeaning:'ordinary'}]}])expect(projectImportMappingSchema.safeParse(value).success).toBe(false);});
 it('rejects invalidUnicode/NUL but keeps pairedsurrogates/leadingzeros literal',()=>{expect(isImportStringSafe('00001😀')).toBe(true);for(const v of ['a\0','\ud800','\udfff'])expect(isImportStringSafe(v)).toBe(false);});
});
