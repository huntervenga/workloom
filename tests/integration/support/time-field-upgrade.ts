import { expect } from 'vitest';

/**
 * Migration 0044 gives every existing project its time fields (estimate and fact): it adds rows to these tables and may
 * move a project's column-settings revision. Upgrade tests that prove "legacy rows are untouched" check that every other
 * table is identical and that every earlier row of these tables is still there.
 */
const TIME_FIELD_TABLES = ['task_field_definitions', 'task_field_definition_versions', 'project_columns', 'project_column_settings'] as const;

export function expectLegacyRowsKeptByTimeFields(after: Record<string, string[]>, before: Record<string, string[]>): void {
  const others = (rows: Record<string, string[]>) => Object.fromEntries(Object.entries(rows).filter(([name]) => !(TIME_FIELD_TABLES as readonly string[]).includes(name)));
  expect(others(after)).toEqual(others(before));
  for (const name of ['task_field_definitions', 'task_field_definition_versions', 'project_columns']) {
    expect(after[name] ?? []).toEqual(expect.arrayContaining(before[name] ?? []));
  }
  const key = (row: string) => { const value = JSON.parse(row) as { workspace_id: string; project_id: string }; return `${value.workspace_id}:${value.project_id}`; };
  expect((after['project_column_settings'] ?? []).map(key)).toEqual(expect.arrayContaining((before['project_column_settings'] ?? []).map(key)));
}
