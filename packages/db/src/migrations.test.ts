import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { MIGRATIONS_FOLDER, MigrationStateError, readExpectedMigrations, runMigrations } from './migrations.js';
import { REQUIRED_TABLES } from './schema.js';

/** `when` of the applied P0 baseline; databases already store it as `created_at`. */
const P0_BASELINE_WHEN = 1792108800000;

// File-level checks only; applying migrations is covered by integration tests.
describe('migration journal', () => {
  const expected = readExpectedMigrations();

  it('lists the migrations with Drizzle-compatible hashes', () => {
    expect(expected.map((migration) => migration.tag)).toEqual(['0000_p0_identity_workspaces', '0001_p1a_tasks', '0002_p1b_fields', '0003_p2a_planning', '0004_p2b_work_categories', '0005_p3a_meetings', '0006_recurrence_materialization', '0007_dependencies_graph', '0008_task_calendar_dates', '0009_project_imports', '0010_local_mcp_credentials']);
    for (const migration of expected) {
      const sqlText = readFileSync(join(MIGRATIONS_FOLDER, `${migration.tag}.sql`), 'utf8');
      expect(migration.hash).toBe(createHash('sha256').update(sqlText).digest('hex'));
    }
  });

  it('keeps the applied P0 baseline ordering key unchanged', () => {
    expect(expected[0]?.createdAt).toBe(P0_BASELINE_WHEN);
  });

  it('keeps journal timestamps strictly increasing', () => {
    for (let index = 1; index < expected.length; index += 1) {
      expect(expected[index]?.createdAt ?? 0).toBeGreaterThan(expected[index - 1]?.createdAt ?? 0);
    }
  });

  it('creates every table the application requires and never drops data', () => {
    const allSql = expected.map((migration) => readFileSync(join(MIGRATIONS_FOLDER, `${migration.tag}.sql`), 'utf8')).join('\n');
    for (const table of REQUIRED_TABLES) {
      expect(allSql).toContain(`CREATE TABLE "${table}"`);
    }
    expect(allSql).not.toMatch(/\b(DROP|TRUNCATE)\s+(TABLE|SCHEMA|DATABASE)\b/i);
    expect(allSql).not.toMatch(/ON DELETE CASCADE/i);
  });

  it('separates every statement with a Drizzle breakpoint', () => {
    for (const migration of expected) {
      const chunks = readFileSync(join(MIGRATIONS_FOLDER, `${migration.tag}.sql`), 'utf8').split('--> statement-breakpoint');
      for (const chunk of chunks) {
        const statements = chunk
          .replace(/--.*$/gm, '')
          .replace(/\$\$[\s\S]*?\$\$/g, '$$body$$')
          .split(';')
          .filter((part) => part.trim() !== '');
        expect(statements.length).toBe(1);
      }
    }
  });
});

describe('migration journal validation', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  /** Writes a migrations folder whose journal lists `whens` verbatim (raw JSON literals). */
  function writeFixture(whens: readonly string[]): string {
    const folder = mkdtempSync(join(tmpdir(), 'workloom-migrations-'));
    dir = folder;
    mkdirSync(join(folder, 'meta'));
    const entries = whens.map((when, idx) => {
      const tag = `000${idx}_fixture`;
      writeFileSync(join(folder, `${tag}.sql`), `SELECT ${idx};\n`);
      return `{ "idx": ${idx}, "version": "7", "when": ${when}, "tag": "${tag}", "breakpoints": true }`;
    });
    writeFileSync(join(folder, 'meta', '_journal.json'), `{ "version": "7", "dialect": "postgresql", "entries": [${entries.join(', ')}] }`);
    return folder;
  }

  it('accepts a strictly increasing journal', () => {
    const folder = writeFixture(['1792108800000', '1792108800001']);
    expect(readExpectedMigrations(folder).map((migration) => migration.createdAt)).toEqual([1792108800000, 1792108800001]);
  });

  it.each([
    ['older than its predecessor', ['1792108800000', '1792102155487']],
    ['equal to its predecessor', ['1792108800000', '1792108800000']],
  ])('rejects a non-monotonic journal entry %s', (_label, whens) => {
    const folder = writeFixture(whens);
    expect(() => readExpectedMigrations(folder)).toThrow(MigrationStateError);
    expect(() => readExpectedMigrations(folder)).toThrow(/0001_fixture .* must be later than 0000_fixture/);
  });

  it.each([
    ['fractional', '1792108800000.5'],
    ['non-finite', '1e400'],
    ['string', '"1792108800000"'],
    ['missing', 'null'],
  ])('rejects a %s journal "when"', (_label, when) => {
    const folder = writeFixture([when]);
    expect(() => readExpectedMigrations(folder)).toThrow(MigrationStateError);
    expect(() => readExpectedMigrations(folder)).toThrow(/0000_fixture has an invalid "when"/);
  });

  it('rejects a non-monotonic journal in runMigrations before connecting', async () => {
    const folder = writeFixture(['1792108800000', '1792102155487']);
    // Port 1 is unused: a connection attempt would fail with a different error.
    await expect(runMigrations('postgres://workloom@127.0.0.1:1/workloom', { migrationsFolder: folder })).rejects.toThrow(
      MigrationStateError,
    );
  });
});
