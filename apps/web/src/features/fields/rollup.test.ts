import { describe, expect, it } from 'vitest';
import type { TaskFieldDefinitionDto, TaskFieldValueDto } from '@workloom/contracts';
import { fieldRollups, isRollupField } from './rollup';

const field = (type: string) => ({ id: 'f', type }) as unknown as TaskFieldDefinitionDto;
const task = (id: string, parentTaskId: string | null = null, archivedAt: string | null = null) => ({ id, parentTaskId, archivedAt });
const values = (entries: Record<string, number | null>) => (id: string) => (id in entries ? ({ value: { type: 'duration', value: entries[id] } } as unknown as TaskFieldValueDto) : null);

describe('parent rollup of number and duration fields', () => {
  it('sums the set values of direct subtasks when the parent has none', () => {
    const result = fieldRollups(field('duration'), [task('p'), task('a', 'p'), task('b', 'p'), task('c', 'p')], values({ a: 60, b: 30, c: null }));
    expect(result.get('p')).toEqual({ type: 'duration', value: 90 });
    expect(result.has('a')).toBe(false);
  });
  it('never replaces a manual value, including an explicit zero', () => {
    const tasks = [task('p'), task('a', 'p')];
    expect(fieldRollups(field('duration'), tasks, values({ p: 15, a: 60 })).size).toBe(0);
    expect(fieldRollups(field('duration'), tasks, values({ p: 0, a: 60 })).size).toBe(0);
  });
  it('rolls up through nested subtasks and lets a manual middle value win', () => {
    const tasks = [task('root'), task('mid', 'root'), task('leaf', 'mid'), task('other', 'root')];
    const open = fieldRollups(field('duration'), tasks, values({ leaf: 20, other: 5 }));
    expect(open.get('mid')).toEqual({ type: 'duration', value: 20 });
    expect(open.get('root')).toEqual({ type: 'duration', value: 25 });
    const manual = fieldRollups(field('duration'), tasks, values({ mid: 100, leaf: 20, other: 5 }));
    expect(manual.get('root')).toEqual({ type: 'duration', value: 105 });
    expect(manual.has('mid')).toBe(false);
  });
  it('shows nothing when no subtask has a value, and ignores archived subtasks', () => {
    expect(fieldRollups(field('duration'), [task('p'), task('a', 'p')], values({})).size).toBe(0);
    expect(fieldRollups(field('duration'), [task('p'), task('a', 'p', '2026-01-01T00:00:00Z')], values({ a: 60 })).size).toBe(0);
  });
  it('only applies to number and duration fields and survives cyclic parents', () => {
    expect(isRollupField(field('text'))).toBe(false);
    expect(fieldRollups(field('text'), [task('p'), task('a', 'p')], values({ a: 1 })).size).toBe(0);
    expect(() => fieldRollups(field('duration'), [task('x', 'y'), task('y', 'x')], values({}))).not.toThrow();
  });
  it('keeps decimal sums exact', () => {
    const data = (id: string) => id === 'p' ? null : ({ value: { type: 'number', value: id === 'a' ? 0.1 : 0.2 } }) as unknown as TaskFieldValueDto;
    expect(fieldRollups(field('number'), [task('p'), task('a', 'p'), task('b', 'p')], data).get('p')).toEqual({ type: 'number', value: 0.3 });
  });
});
