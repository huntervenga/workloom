// Runs the @workloom/db CLIs the way `npm run db:migrate` / `npm run db:seed:demo` do:
// `tsx src/cli/<name>.ts` with the package directory as the working directory.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type postgres from 'postgres';

import { repoRoot } from './api-process.js';

const dbPackageDir = join(repoRoot, 'packages/db');

export interface CliResult {
  readonly code: number | null;
  readonly output: string;
}

export function runDbCli(script: 'migrate' | 'seed-demo', databaseUrl: string): Promise<CliResult> {
  const entry = join(dbPackageDir, 'src/cli', `${script}.ts`);
  if (!existsSync(entry)) {
    return Promise.reject(new Error(`Missing ${entry}: the ${script} CLI of @workloom/db is not implemented yet.`));
  }
  const child = spawn(process.execPath, ['--import', 'tsx', entry], {
    cwd: dbPackageDir,
    // Explicit env: the developer's DATABASE_URL never reaches the CLI. A repo .env may still
    // fill unset keys, but DATABASE_URL and APP_ENV here always win.
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', APP_ENV: 'local', DATABASE_URL: databaseUrl },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${script} did not finish within 60s:\n${output}`));
    }, 60_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

export async function migrateAndSeed(databaseUrl: string): Promise<void> {
  for (const script of ['migrate', 'seed-demo'] as const) {
    const result = await runDbCli(script, databaseUrl);
    if (result.code !== 0) throw new Error(`db ${script} failed with code ${result.code}:\n${result.output}`);
  }
}

const userSchemas = `n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'`;

/** Tables, columns, constraints and indexes of every non-system schema, in stable order. */
export async function catalogSnapshot(sql: postgres.Sql): Promise<string[]> {
  const columns = await sql.unsafe<{ line: string }[]>(`
    SELECT n.nspname || '.' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
           || CASE WHEN a.attnotnull THEN ' not null' ELSE '' END AS line
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped AND ${userSchemas}
    ORDER BY 1`);
  const constraints = await sql.unsafe<{ line: string }[]>(`
    SELECT n.nspname || '.' || cl.relname || ' ' || co.conname || ' ' || pg_get_constraintdef(co.oid) AS line
    FROM pg_constraint co
    JOIN pg_class cl ON cl.oid = co.conrelid
    JOIN pg_namespace n ON n.oid = cl.relnamespace
    WHERE ${userSchemas}
    ORDER BY 1`);
  const indexes = await sql.unsafe<{ line: string }[]>(`
    SELECT schemaname || ' ' || indexdef AS line FROM pg_indexes
    WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
    ORDER BY 1`);
  return [...columns, ...constraints, ...indexes].map((row) => row.line);
}

export interface TableRef {
  readonly schema: string;
  readonly table: string;
}

export async function userTables(sql: postgres.Sql): Promise<TableRef[]> {
  const rows = await sql.unsafe<{ schema: string; table: string }[]>(`
    SELECT n.nspname AS schema, c.relname AS table
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p') AND ${userSchemas}
    ORDER BY 1, 2`);
  return rows.map((row) => ({ schema: row.schema, table: row.table }));
}

/** `schema.table → row count` for every user table. */
export async function rowCounts(sql: postgres.Sql): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const { schema, table } of await userTables(sql)) {
    const [row] = await sql.unsafe<{ count: string }[]>(`SELECT count(*)::text AS count FROM "${schema}"."${table}"`);
    counts[`${schema}.${table}`] = Number(row?.count ?? 0);
  }
  return counts;
}

/** `schema.table → sorted ids` for every user table that has an `id` column. */
export async function idSets(sql: postgres.Sql): Promise<Record<string, string[]>> {
  const withId = await sql.unsafe<{ schema: string; table: string }[]>(`
    SELECT table_schema AS schema, table_name AS table FROM information_schema.columns
    WHERE column_name = 'id' AND table_schema NOT IN ('pg_catalog', 'information_schema')
    ORDER BY 1, 2`);
  const ids: Record<string, string[]> = {};
  for (const { schema, table } of withId) {
    const rows = await sql.unsafe<{ id: string }[]>(`SELECT id::text AS id FROM "${schema}"."${table}" ORDER BY 1`);
    ids[`${schema}.${table}`] = rows.map((row) => row.id);
  }
  return ids;
}
