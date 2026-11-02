#!/usr/bin/env node
/**
 * The runtime image copies an explicit list of scripts. A script the hosted API loads that imports a file missing from
 * that list crashes startup in production ("Workloom API failed to start: Error"), which no local run shows. This
 * checks that every script the runtime loads, and everything those import, is copied into the image.
 */
import {readFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const IMPORT=/(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)['"]\.\/([A-Za-z0-9._-]+\.mjs)['"]/g;

export function copiedScripts(dockerfileText){
 const copied=new Set();
 for(const line of dockerfileText.split('\n'))if(/^COPY\s+--from=build/.test(line))for(const match of line.matchAll(/\/app\/scripts\/([A-Za-z0-9._-]+\.mjs)/g))copied.add(match[1]);
 return copied;
}
/** Scripts the runtime starts or loads: the pre-deploy command and anything the API names under scripts/. */
export function runtimeEntries({railwayJsonText,apiSources}){
 const entries=new Set();
 for(const match of railwayJsonText.matchAll(/scripts\/([A-Za-z0-9._-]+\.mjs)/g))entries.add(match[1]);
 for(const source of apiSources)for(const match of source.matchAll(/scripts\/([A-Za-z0-9._-]+\.mjs)/g))entries.add(match[1]);
 return entries;
}
export function missingFromImage({dockerfileText,entries,readScript}){
 const copied=copiedScripts(dockerfileText),needed=new Set(),pending=[...entries];
 while(pending.length>0){
  const name=pending.pop();if(needed.has(name))continue;needed.add(name);
  for(const match of readScript(name).matchAll(IMPORT))pending.push(match[1]);
 }
 return [...needed].filter(name=>!copied.has(name)).sort();
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
 const read=path=>readFileSync(join(root,path),'utf8');
 const apiFiles=['apps/api/src/app.ts'];
 const missing=missingFromImage({
  dockerfileText:read('Dockerfile'),
  entries:runtimeEntries({railwayJsonText:read('railway.json'),apiSources:apiFiles.map(read)}),
  readScript:name=>read(`scripts/${name}`),
 });
 if(missing.length>0){console.error(`Dockerfile does not copy scripts the hosted runtime needs: ${missing.join(', ')}`);process.exit(1);}
 console.log('deploy image: every runtime script and its imports are copied');
}
