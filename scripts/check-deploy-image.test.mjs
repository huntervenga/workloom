import test from 'node:test';
import assert from 'node:assert/strict';
import {copiedScripts,missingFromImage,runtimeEntries} from './check-deploy-image.mjs';

const dockerfile=`FROM x
COPY --from=build --chown=node:node /app/scripts/a.mjs /app/scripts/b.mjs ./scripts/
COPY --from=build --chown=node:node /app/scripts/c.mjs ./scripts/c.mjs
COPY . .
`;
const sources={'a.mjs':"import x from './b.mjs';",'b.mjs':"export * from './c.mjs';const m=await import('./d.mjs');",'c.mjs':'','d.mjs':"import './e.mjs'",'e.mjs':''};

test('reads the copied scripts from the runtime stage only',()=>{
 assert.deepEqual([...copiedScripts(dockerfile)].sort(),['a.mjs','b.mjs','c.mjs']);
});
test('names every imported script (static or dynamic, any depth) that the image lacks',()=>{
 assert.deepEqual(missingFromImage({dockerfileText:dockerfile,entries:new Set(['a.mjs']),readScript:n=>sources[n]}),['d.mjs','e.mjs']);
 assert.deepEqual(missingFromImage({dockerfileText:dockerfile+'COPY --from=build /app/scripts/d.mjs /app/scripts/e.mjs ./scripts/\n',entries:new Set(['a.mjs']),readScript:n=>sources[n]}),[]);
});
test('finds the runtime entries in the pre-deploy command and in the API source',()=>{
 const entries=runtimeEntries({railwayJsonText:'{"preDeployCommand":["node scripts/hosted-migrate.mjs --apply"]}',apiSources:["new URL('../../../scripts/asana-browser-import.mjs',import.meta.url)"]});
 assert.deepEqual([...entries].sort(),['asana-browser-import.mjs','hosted-migrate.mjs']);
});
test('the real repository passes',async()=>{
 const {execFileSync}=await import('node:child_process');
 assert.match(execFileSync(process.execPath,['scripts/check-deploy-image.mjs'],{encoding:'utf8'}),/every runtime script/);
});
