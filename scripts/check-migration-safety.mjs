#!/usr/bin/env node
/**
 * Production was loaded without most foreign keys and triggers, so a migration that drops an object by name can fail
 * there with 42704 ("does not exist") while passing on every development database. From 0038 on (0037 is already applied in
 * production, and its remaining drop was checked against the production catalog), every DROP of a constraint, trigger, index, function, type, column or table must say IF EXISTS, or sit
 * in a DO block that tests for the object first.
 */
import {readdirSync,readFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const FIRST_GUARDED_MIGRATION=38;
const DROP=/\bDROP\s+(CONSTRAINT|TRIGGER|INDEX|FUNCTION|TYPE|COLUMN|TABLE|POLICY|VIEW)\b/i;

const withoutComments=text=>text.replace(/\/\*[\s\S]*?\*\//g,'').replace(/--[^\n]*/g,'');

/** Statements of one migration file that drop something without a guard. */
export function unguardedDrops(sqlText){
 const problems=[];
 for(const raw of sqlText.split('--> statement-breakpoint')){
  const statement=withoutComments(raw).trim();if(!statement)continue;
  const drop=DROP.exec(statement);if(!drop)continue;
  const guardedInline=/\bIF\s+EXISTS\b/i.test(statement)&&!/^DO\b/i.test(statement)&&new RegExp(`\\bDROP\\s+${drop[1]}\\s+IF\\s+EXISTS\\b`,'i').test(statement);
  const guardedBlock=/^DO\b/i.test(statement)&&/\bIF\s+(NOT\s+)?EXISTS\s*\(/i.test(statement);
  if(!guardedInline&&!guardedBlock)problems.push(statement.replace(/\s+/g,' ').slice(0,140));
 }
 return problems;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const folder=join(resolve(dirname(fileURLToPath(import.meta.url)),'..'),'packages/db/migrations');
 let bad=0;
 for(const name of readdirSync(folder).filter(file=>/^\d{4}_.*\.sql$/.test(file)).sort()){
  if(Number(name.slice(0,4))<FIRST_GUARDED_MIGRATION)continue;
  for(const problem of unguardedDrops(readFileSync(join(folder,name),'utf8'))){console.error(`${name}: unguarded drop: ${problem}`);bad+=1;}
 }
 if(bad>0)process.exit(1);
 console.log('migrations: every drop since 0038 is guarded');
}
