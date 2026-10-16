import {describe,expect,it} from 'vitest';
import {dependencyGraphQuerySchema,dependencyGraphInputSchema,taskDependencyListQuerySchema,setGraphLayoutInputSchema} from './dependencies.js';
const a='abcdef00-0000-4000-8000-000000000001',b='abcdef00-0000-4000-8000-000000000002';
describe('P4a strict query and bounded layout contracts',()=>{
 it('normalizes valid CSV once and independently validates normalized domain input',()=>{const wire=dependencyGraphQuerySchema.parse({rootTaskIds:`${b},${a.toUpperCase()}`,neighborDepth:'2'});expect(wire).toEqual({rootTaskIds:[a,b],neighborDepth:2});expect(dependencyGraphInputSchema.parse(wire)).toEqual(wire);});
 it.each([{rootTaskIds:[a]},{rootTaskIds:`${a},${a.toUpperCase()}`},{rootTaskIds:a,neighborDepth:'3'},{rootTaskIds:''},{rootTaskIds:a,extra:'x'}])('rejects malformed wire query %j',value=>{expect(dependencyGraphQuerySchema.safeParse(value).success).toBe(false);});
 it('requires exactly one list scope',()=>{expect(taskDependencyListQuerySchema.safeParse({taskId:a,projectId:b}).success).toBe(false);expect(taskDependencyListQuerySchema.safeParse({projectId:a,direction:'incoming'}).success).toBe(false);expect(taskDependencyListQuerySchema.parse({taskId:a})).toMatchObject({direction:'both',state:'active',limit:50});});
 it.each([NaN,Infinity,-Infinity,100001,-100001])('rejects coordinate %s',x=>{expect(setGraphLayoutInputSchema.safeParse({expectedRevision:0,positions:[{taskId:a,x,y:0}]}).success).toBe(false);});
});
