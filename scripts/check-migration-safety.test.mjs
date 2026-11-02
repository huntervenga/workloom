import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {unguardedDrops} from './check-migration-safety.mjs';

test('a bare drop is flagged, a drop with IF EXISTS is not',()=>{
 assert.equal(unguardedDrops('ALTER TABLE "t" DROP CONSTRAINT "t_fk";').length,1);
 assert.equal(unguardedDrops('ALTER TABLE "t" DROP CONSTRAINT IF EXISTS "t_fk";').length,0);
 assert.equal(unguardedDrops('DROP TRIGGER x ON t;\n--> statement-breakpoint\nDROP INDEX IF EXISTS i;').length,1);
});
test('a DO block that tests for the object first is accepted, one that does not is flagged',()=>{
 assert.equal(unguardedDrops("DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='x') THEN ALTER TABLE t DROP CONSTRAINT x; END IF; END $$;").length,0);
 assert.equal(unguardedDrops('DO $$ BEGIN ALTER TABLE t DROP CONSTRAINT x; END $$;').length,1);
});
test('comments do not count, and statements without drops are ignored',()=>{
 assert.equal(unguardedDrops('-- DROP CONSTRAINT mentioned in a comment\nALTER TABLE t ADD COLUMN c int;').length,0);
});
test('the real migrations pass',()=>{
 assert.match(execFileSync(process.execPath,['scripts/check-migration-safety.mjs'],{encoding:'utf8'}),/every drop since 0038 is guarded/);
});
