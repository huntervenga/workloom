import { describe, expect, it } from 'vitest';
import { personalTablePreferenceSchema, taskTableBuiltinColumnSchema, updatePersonalTablePreferenceInputSchema, type ColumnChoice } from './table-preferences.js';
const id = (n: number) => `ad000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const title: ColumnChoice = { column: { kind: 'builtin', key: 'title' }, visible: true };
const field = (n: number): ColumnChoice => ({ column: { kind: 'field', fieldId: id(n) }, visible: n % 2 === 0 });
const parse = (columns: unknown) => updatePersonalTablePreferenceInputSchema.safeParse({ expectedRevision: 0, columns });
describe('personal column reference properties and bounds', () => {
  it('preserves every visibility combination and permuted order after the pinned title', () => {
    const rest = taskTableBuiltinColumnSchema.options.filter(key => key !== 'title');
    for (let bits = 0; bits < 1 << rest.length; bits++) {
      const columns: ColumnChoice[] = [title, ...rest.map((_, n) => ({ column: { kind: 'builtin' as const, key: rest[(n + bits) % rest.length] as typeof rest[number] }, visible: Boolean(bits & 1 << n) })), field(bits + 1)];
      expect(updatePersonalTablePreferenceInputSchema.parse({ expectedRevision: bits, columns })).toEqual({ expectedRevision: bits, columns });
    }
  });
  it('independently bounds custom count and total count', () => {
    const allBuiltins = taskTableBuiltinColumnSchema.options.map(key => ({ column: { kind: 'builtin' as const, key }, visible: true }));
    expect(parse([...allBuiltins, ...Array.from({ length: 200 }, (_, n) => field(n + 1))]).success).toBe(true);
    expect(parse([title, ...Array.from({ length: 201 }, (_, n) => field(n + 1))]).success).toBe(false);
    expect(parse([...allBuiltins, ...Array.from({ length: 201 }, (_, n) => field(n + 1))]).success).toBe(false);
  });
  it('rejects hidden/misplaced title, duplicate canonical refs, arbitrary IDs/keys and client-selected identity', () => {
    for (const columns of [[], [{ ...title, visible: false }], [field(1), title], [title, title], [title, field(1), { ...field(1), column: { kind: 'field', fieldId: id(1).toUpperCase() } }], [title, { column: { kind: 'builtin', key: 'arbitrary' }, visible: true }], [title, { column: { kind: 'field', fieldId: 'not-a-uuid' }, visible: false }], [title, { column: { kind: 'custom', fieldId: id(1) }, visible: true }]]) expect(parse(columns).success).toBe(false);
    expect(updatePersonalTablePreferenceInputSchema.safeParse({ expectedRevision: 0, columns: null, membershipId: id(1) }).success).toBe(false);
  });
  it('distinguishes revision-zero absence, versioned reset and malformed revisions', () => {
    expect(updatePersonalTablePreferenceInputSchema.parse({ expectedRevision: 3, columns: null })).toEqual({ expectedRevision: 3, columns: null });
    expect(personalTablePreferenceSchema.safeParse({ workspaceId: id(1), projectId: id(2), membershipId: id(3), revision: 0, columns: null }).success).toBe(true);
    expect(personalTablePreferenceSchema.safeParse({ workspaceId: id(1), projectId: id(2), membershipId: id(3), revision: 0, columns: [title] }).success).toBe(false);
    for (const expectedRevision of [-1, 1.2, '0', 2147483648]) expect(updatePersonalTablePreferenceInputSchema.safeParse({ expectedRevision, columns: null }).success).toBe(false);
  });
});
