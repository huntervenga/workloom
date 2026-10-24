import type { TaskDefaultsConfig, TaskDto, TaskFieldDefinitionDto } from '@workloom/contracts';
import { describe, expect, it } from 'vitest';
import { startFieldsFromDefaults, startValuesFromDefaults } from './startValues';

const empty: TaskDefaultsConfig = { statusId: null, priority: null, estimateMinutes: null, fieldValues: [] };
const above = { responsibleMembershipId: 'm1', dueDate: '2026-10-21', priority: 'high', estimateMinutes: 90, tags: [{ id: 't1', archivedAt: null }, { id: 't2', archivedAt: '2026-01-01T00:00:00.000Z' }] } as unknown as TaskDto;

describe('what a new row starts with', () => {
  it('copies the task above, uses today, and ignores archived tags', () => {
    const config: TaskDefaultsConfig = { ...empty, assignee: { kind: 'above' }, tags: { kind: 'above' }, dueDate: { kind: 'today', offsetDays: 2 }, fromAbove: { priority: true, estimate: true, fieldIds: [] } };
    expect(startValuesFromDefaults(config, above, { today: '2026-10-30', subtask: false })).toEqual({ responsibleMembershipId: 'm1', tagIds: ['t1'], dueDate: '2026-11-01', priority: 'high', estimate: '1:30' });
  });
  it('sets nothing for a copy rule without a task above, and no estimate on a subtask', () => {
    const config: TaskDefaultsConfig = { ...empty, estimateMinutes: 60, assignee: { kind: 'above' }, dueDate: { kind: 'above' } };
    expect(startValuesFromDefaults(config, null, { today: '2026-10-30', subtask: false })).toEqual({ estimate: '1:00' });
    expect(startValuesFromDefaults(config, null, { today: '2026-10-30', subtask: true })).toEqual({});
  });
  it('shows a fixed assignee and priority, and is empty for empty defaults', () => {
    expect(startValuesFromDefaults({ ...empty, priority: 'low', assignee: { kind: 'fixed', membershipId: 'm9' } }, null, { today: undefined, subtask: false })).toEqual({ responsibleMembershipId: 'm9', priority: 'low' });
    expect(startValuesFromDefaults(empty, above, { today: '2026-10-30', subtask: false })).toEqual({});
  });
});

describe('ordinary field values a new row starts with', () => {
  const field = (id: string, type: string, extra: object = {}) => ({ id, type, name: id, archivedAt: null, locked: false, options: [], ...extra }) as unknown as TaskFieldDefinitionDto;
  const fields = [field('hours', 'duration'), field('due', 'date'), field('locked', 'duration', { locked: true }), field('gone', 'duration', { archivedAt: '2026-01-01T00:00:00.000Z' })];
  const options = { today: '2026-10-30', fields, valueOf: () => undefined };
  it('stages a fixed duration and a date of today, and skips locked, archived and mismatched fields', () => {
    const config: TaskDefaultsConfig = { ...empty, todayFields: [{ fieldId: 'due', offsetDays: 2 }], fieldValues: [
      { fieldId: 'hours', value: { type: 'duration', value: 90 } }, { fieldId: 'locked', value: { type: 'duration', value: 5 } },
      { fieldId: 'gone', value: { type: 'duration', value: 5 } }, { fieldId: 'due', value: { type: 'duration', value: 5 } },
    ] };
    const staged = startFieldsFromDefaults(config, null, options);
    expect(Object.keys(staged).sort()).toEqual(['due', 'hours']);
    expect(staged['hours']?.draft).toEqual({ type: 'duration', text: '1:30' });
    expect(staged['due']?.draft).toEqual({ type: 'date', text: '2026-11-01' });
  });
  it('prefers the task above, then today, then the fixed value', () => {
    const config: TaskDefaultsConfig = { ...empty, fromAbove: { priority: false, estimate: false, fieldIds: ['hours'] }, fieldValues: [{ fieldId: 'hours', value: { type: 'duration', value: 30 } }] };
    expect(startFieldsFromDefaults(config, above, { ...options, valueOf: () => ({ type: 'duration', value: 120 }) })['hours']?.draft).toEqual({ type: 'duration', text: '2:00' });
    expect(startFieldsFromDefaults(config, above, options)['hours']?.draft).toEqual({ type: 'duration', text: '0:30' });
  });
});
