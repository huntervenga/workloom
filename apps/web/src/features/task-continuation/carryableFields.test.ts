import type { TaskFieldDefinitionDto } from '@workloom/contracts';
import { describe, expect, it } from 'vitest';
import { carryableFields } from './carryableFields';

const field = (id: string, name: string, type: string, archivedAt: string | null = null) => ({ id, name, type, archivedAt }) as unknown as TaskFieldDefinitionDto;

describe('fields that can be copied on continue', () => {
  it('offers same-named, same-typed number/time fields and never choices, people or archived fields', () => {
    const source = [field('a', 'Budget', 'duration'), field('b', 'Kind', 'single_select'), field('c', 'Owner', 'person'), field('d', 'Old', 'number', '2026-01-01T00:00:00.000Z'), field('e', 'Score', 'number'), field('f', 'Due', 'date')];
    const target = [field('1', ' budget ', 'duration'), field('2', 'Kind', 'single_select'), field('3', 'Owner', 'person'), field('4', 'Old', 'number'), field('5', 'Score', 'text')];
    expect(carryableFields(source, target).map(f => f.id)).toEqual(['a']);
  });
});
