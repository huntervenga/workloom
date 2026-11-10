import { describe, expect, it } from 'vitest';
import { attributedAssignees, type AttributableTask } from './attribution.js';

const id = (number: number) => `00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;
const personA = id(901), personB = id(902);
const task = (number: number, parent: number | null, assignee: string | null): AttributableTask => ({ id: id(number), parentTaskId: parent === null ? null : id(parent), responsibleMembershipId: assignee });

describe('attributed assignees', () => {
  it('keeps every task with its own assignee and leaves an unassigned root unassigned', () => {
    const result = attributedAssignees([task(1, null, personA), task(2, null, null), task(3, 1, personB)]);
    expect(result.get(id(1))).toBe(personA);
    expect(result.get(id(2))).toBeNull();
    // An explicit subtask assignee wins over the parent's.
    expect(result.get(id(3))).toBe(personB);
  });

  it('counts an unassigned subtask for the nearest assigned ancestor, at any depth and in any order', () => {
    const result = attributedAssignees([task(13, 12, null), task(12, 11, null), task(11, 10, personB), task(10, null, personA), task(14, 2, null), task(2, null, null)]);
    expect(result.get(id(12))).toBe(personB);
    expect(result.get(id(13))).toBe(personB);
    expect(result.get(id(14))).toBeNull();
  });

  it('matches IDs case-insensitively and stops at a parent outside the list or a cycle', () => {
    const upper = { id: id(21).toUpperCase(), parentTaskId: id(20).toUpperCase(), responsibleMembershipId: null };
    const result = attributedAssignees([task(20, null, personA), upper, task(22, 99, null), task(23, 24, null), task(24, 23, null)]);
    expect(result.get(id(21))).toBe(personA);
    expect(result.get(id(22))).toBeNull();
    expect(result.get(id(23))).toBeNull();
    expect(result.get(id(24))).toBeNull();
  });
});
