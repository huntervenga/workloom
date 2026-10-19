import type { ColumnChoice, TaskTableBuiltinColumn } from '@workloom/contracts';
import { describe, expect, it } from 'vitest';
import { columns, field, PROJECT_ID, STAMP } from '../fields/test/fixtures';
import { columnKey, reconcilePersonalColumns, tableColumnId } from './personalColumns';

const builtin = (key: TaskTableBuiltinColumn, visible = true): ColumnChoice => ({ column: { kind: 'builtin', key }, visible });
const note = field('Stored field');
const other = field('Other field', 'text', '90000000-0000-4000-8000-000000000002');
const keys = (choices: readonly ColumnChoice[]) => choices.map(choice => columnKey(choice.column));

describe('pure personal column reconciliation', () => {
  it('follows current shared visibility under null with tags visible and no legacy compact gate', () => {
    const settings = columns([note, other]); settings.columns = settings.columns.map((choice, index) => ({ ...choice, visible: index !== 1 }));
    const result = reconcilePersonalColumns(null, [note, other], settings, false);
    expect(result.effectiveVisibleRefs.map(tableColumnId)).toEqual(['title', 'status', 'responsible', 'dueDate', 'tags', note.id]);
    expect(result.choices.find(choice => columnKey(choice.column) === 'builtin:weeklyPlan')?.visible).toBe(true);
    expect(result.addedRefs).toEqual([]);
    const changed = reconcilePersonalColumns(null, [note, other], { ...settings, columns: settings.columns.map(choice => ({ ...choice, visible: true })) }, true);
    expect(changed.effectiveVisibleRefs.map(tableColumnId)).toContain(other.id);
    expect(changed.effectiveVisibleRefs.map(tableColumnId)).toContain('weekly-fact');
  });

  it('preserves stored visible/hidden order and personal flags when shared defaults change', () => {
    const stored = [builtin('title'), { column: { kind: 'field' as const, fieldId: note.id }, visible: true }, builtin('estimate'), builtin('tags', false)];
    const settings = columns([note]); settings.columns = settings.columns.map(choice => ({ ...choice, visible: false }));
    const result = reconcilePersonalColumns(stored, [note], settings, false);
    expect(result.choices.slice(0, stored.length)).toEqual(stored);
    expect(result.effectiveVisibleRefs.map(tableColumnId).slice(0, 2)).toEqual(['title', note.id]);
    expect(result.effectiveVisibleRefs.map(tableColumnId)).not.toContain('estimate');
    expect(result.effectiveVisibleRefs.map(tableColumnId)).not.toContain('tags');
    expect(stored).toHaveLength(4);
  });

  it('retains disabled own fields and their position, recovering visibility on reactivation', () => {
    const stored = [builtin('title'), { column: { kind: 'field' as const, fieldId: note.id }, visible: true }, builtin('estimate')];
    const disabled = reconcilePersonalColumns(stored, [{ ...note, archivedAt: STAMP }], columns([note]), true);
    expect(disabled.choices.slice(0, 3)).toEqual(stored); expect(disabled.inactiveRefs).toEqual([stored[1]?.column]);
    expect(disabled.effectiveVisibleRefs.map(tableColumnId)).not.toContain(note.id);
    expect(reconcilePersonalColumns(stored, [note], columns([note]), true).effectiveVisibleRefs.map(tableColumnId)).toContain(note.id);
  });

  it('appends new choices without changing an existing entry and hides fields absent from shared settings', () => {
    const stored = [builtin('title'), builtin('estimate')];
    const result = reconcilePersonalColumns(stored, [note, other], columns([note]), false);
    expect(result.choices.slice(0, 2)).toEqual(stored);
    expect(result.choices.at(-1)).toEqual({ column: { kind: 'field', fieldId: other.id }, visible: false });
    expect(result.addedRefs).toContainEqual({ kind: 'field', fieldId: note.id });
  });

  it('keeps weekly choices unchanged across availability without inventing cells', () => {
    const stored = [builtin('title'), builtin('weeklyActual'), builtin('weeklyPlan', false)];
    const absent = reconcilePersonalColumns(stored, [], columns([]), false);
    const available = reconcilePersonalColumns(stored, [], columns([]), true);
    expect(absent.choices).toEqual(available.choices);
    expect(absent.effectiveVisibleRefs.map(tableColumnId)).not.toContain('weekly-fact');
    expect(available.effectiveVisibleRefs.map(tableColumnId)).toContain('weekly-fact');
    expect(available.effectiveVisibleRefs.map(tableColumnId)).not.toContain('weekly-plan');
  });

  it('retains invalid refs as inert explicit-review entries without resolving foreign field metadata', () => {
    const stored = [builtin('title'), { column: { kind: 'field' as const, fieldId: note.id }, visible: true }];
    const result = reconcilePersonalColumns(stored, [{ ...note, projectId: 'e0000000-0000-4000-8000-000000000099' }], { ...columns([]), projectId: PROJECT_ID }, false);
    expect(result.choices[1]).toEqual(stored[1]); expect(result.invalidRefs).toEqual([stored[1]?.column]);
    expect(result.effectiveVisibleRefs.map(tableColumnId)).not.toContain(note.id);
  });

  it('reports overflow without silently dropping choices', () => {
    const many = Array.from({ length: 201 }, (_, index) => field('Stored field', 'text', `90000000-0000-4000-8000-${String(index).padStart(12, '0')}`));
    const stored: ColumnChoice[] = [builtin('title'), ...many.map(item => ({ column: { kind: 'field' as const, fieldId: item.id }, visible: true }))];
    const result = reconcilePersonalColumns(stored, many, columns(many), true);
    expect(result.limitExceeded).toBe(true); expect(result.choices.length).toBe(211); expect(keys(result.choices)).toContain(`field:${many[200]?.id}`);
  });
});
