import test from 'node:test';
import assert from 'node:assert/strict';
import {dependencyTargets} from './import-asana-project.mjs';

test('dependency segmentation rejects adversarial unresolved suffix in bounded work',()=>{
 // Each a-prefix can be segmented in exponentially many ways, but no path reaches z.
 const names=new Map(Array.from({length:49},(_,i)=>[Array(i+1).fill('a').join(','),[String(i+1)]]));
 assert.equal(dependencyTargets([...Array(49).fill('a'),'z'].join(','),names),null);
});
test('dependency segmentation preserves exact names, uniqueness and ambiguity semantics',()=>{
 assert.deepEqual(dependencyTargets('a,b',new Map([['a,b',['whole']],['a',['a']],['b',['b']]])),['whole']);
 assert.deepEqual(dependencyTargets('a,b,c',new Map([['a',['a']],['b,c',['bc']]])),['a','bc']);
 assert.equal(dependencyTargets('a,b,c',new Map([['a',['a']],['b',['b']],['c',['c']],['a,b',['ab']]])),null);
 assert.equal(dependencyTargets('a,a',new Map([['a',['same']]])),null);
 assert.equal(dependencyTargets('a',new Map([['a',['one','two']]])),null);
});
