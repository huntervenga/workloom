import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { sqlCalendarDateSchema } from './common/sql-date.js';
import { createTaskFieldDataSchema } from './common/task-field-data.js';
import { taskFieldDataSchema } from './fields.js';
import { calendarDateSchema, minutesSchema } from './tasks.js';

const ID_1 = '00000000-0000-4000-8000-000000000001';
const ID_2 = '00000000-0000-4000-8000-000000000002';
const ID_3 = '00000000-0000-4000-8000-000000000003';
const ID_A_UPPER = '00000000-0000-4000-8000-00000000000A';
const ID_A = '00000000-0000-4000-8000-00000000000a';
const ID_B_UPPER = '00000000-0000-4000-8000-00000000000B';
const ID_B = '00000000-0000-4000-8000-00000000000b';

const idAt = (index: number) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
const ids = (count: number) => Array.from({ length: count }, (_, index) => idAt(index + 1));

/** `[input, expected parsed output]`; `input` is returned unchanged when `expected` is omitted. */
type Accepted = [input: unknown, expected?: unknown];

const accepted: Record<string, readonly Accepted[]> = {
  text: [
    [{ type: 'text', value: '' }],
    [{ type: 'text', value: '  padded\n text  ' }],
    [{ type: 'text', value: 'x'.repeat(10_000) }],
    [{ type: 'text', value: null }],
  ],
  number: [
    [{ type: 'number', value: 0 }],
    [{ type: 'number', value: -0.5 }],
    [{ type: 'number', value: 1e12 }],
    [{ type: 'number', value: -1e12 }],
    [{ type: 'number', value: null }],
  ],
  duration: [
    [{ type: 'duration', value: 0 }],
    [{ type: 'duration', value: 90 }],
    [{ type: 'duration', value: 2_147_483_647 }],
    [{ type: 'duration', value: null }],
  ],
  date: [
    [{ type: 'date', value: '2026-10-18' }],
    [{ type: 'date', value: '2024-02-29' }],
    [{ type: 'date', value: '9999-12-31' }],
    // The tasks calendar date has no year >= 1 check; that lives only in the SQL date schema.
    [{ type: 'date', value: '0000-01-01' }],
    [{ type: 'date', value: null }],
  ],
  single_select: [
    [{ type: 'single_select', value: ID_1 }],
    [
      { type: 'single_select', value: ID_A_UPPER },
      { type: 'single_select', value: ID_A },
    ],
    [{ type: 'single_select', value: null }],
  ],
  multi_select: [
    [{ type: 'multi_select', value: [] }],
    [
      { type: 'multi_select', value: [ID_3, ID_1, ID_2] },
      { type: 'multi_select', value: [ID_1, ID_2, ID_3] },
    ],
    [
      { type: 'multi_select', value: [ID_B_UPPER, ID_A_UPPER] },
      { type: 'multi_select', value: [ID_A, ID_B] },
    ],
    [{ type: 'multi_select', value: ids(100) }],
    [{ type: 'multi_select', value: null }],
  ],
  person: [
    [{ type: 'person', value: [] }],
    [
      { type: 'person', value: [ID_2, ID_A_UPPER, ID_1] },
      { type: 'person', value: [ID_1, ID_2, ID_A] },
    ],
    [{ type: 'person', value: null }],
  ],
  boolean: [
    [{ type: 'boolean', value: false }],
    [{ type: 'boolean', value: true }],
    [{ type: 'boolean', value: null }],
  ],
  url: [
    [{ type: 'url', value: 'https://example.com/path?q=1#top' }],
    [{ type: 'url', value: 'http://localhost:8080' }],
    [{ type: 'url', value: `https://example.com/${'a'.repeat(2048 - 'https://example.com/'.length)}` }],
    [{ type: 'url', value: null }],
  ],
};

const rejected: Record<string, readonly unknown[]> = {
  shape: [
    null,
    'text',
    {},
    { value: 'x' },
    { type: 'formula', value: 1 },
    { type: 'TEXT', value: 'x' },
    { type: 'text' },
    { type: 'text', value: undefined },
    { type: 'text', value: 'x', extra: true },
    { type: 'single_select', value: ID_1, label: 'High' },
    { type: 'number', value: 1, fieldId: ID_1 },
  ],
  text: [
    { type: 'text', value: 'x'.repeat(10_001) },
    { type: 'text', value: 1 },
  ],
  number: [
    { type: 'number', value: 1e12 + 1 },
    { type: 'number', value: -1e12 - 1 },
    { type: 'number', value: Number.NaN },
    { type: 'number', value: Number.POSITIVE_INFINITY },
    { type: 'number', value: '1' },
  ],
  duration: [
    { type: 'duration', value: -1 },
    { type: 'duration', value: 1.5 },
    { type: 'duration', value: 2_147_483_648 },
    { type: 'duration', value: '30' },
  ],
  date: [
    { type: 'date', value: '2026-02-29' },
    { type: 'date', value: '2026-02-30' },
    { type: 'date', value: '2026-13-01' },
    { type: 'date', value: '2026-1-01' },
    { type: 'date', value: '10000-01-01' },
    { type: 'date', value: '2026-10-18T00:00:00Z' },
    { type: 'date', value: ' 2026-10-18' },
    { type: 'date', value: '' },
  ],
  single_select: [
    { type: 'single_select', value: 'high' },
    { type: 'single_select', value: [ID_1] },
    { type: 'single_select', value: '' },
  ],
  multi_select: [
    { type: 'multi_select', value: ID_1 },
    { type: 'multi_select', value: [ID_1, ID_1] },
    { type: 'multi_select', value: [ID_A, ID_A_UPPER] },
    { type: 'multi_select', value: ['not-an-id'] },
    { type: 'multi_select', value: ids(101) },
  ],
  person: [
    { type: 'person', value: [ID_2, ID_2] },
    { type: 'person', value: [ID_B_UPPER, ID_B] },
    { type: 'person', value: ID_1 },
  ],
  boolean: [
    { type: 'boolean', value: 'false' },
    { type: 'boolean', value: 0 },
  ],
  url: [
    { type: 'url', value: 'https://user:secret@example.com/' },
    { type: 'url', value: 'https://user@example.com/' },
    { type: 'url', value: 'https://example.com@evil.example/' },
    { type: 'url', value: ' https://example.com/' },
    { type: 'url', value: 'https://example.com/ ' },
    { type: 'url', value: 'https://example.com/a b' },
    { type: 'url', value: 'https://example.com/\n' },
    { type: 'url', value: 'https://example.com/\u0000' },
    { type: 'url', value: 'https://example.com/\u007f' },
    { type: 'url', value: 'http:example.com' },
    { type: 'url', value: 'https://' },
    { type: 'url', value: 'ftp://example.com/' },
    { type: 'url', value: 'javascript:alert(1)' },
    { type: 'url', value: 'example.com' },
    { type: 'url', value: '' },
    { type: 'url', value: `https://example.com/${'a'.repeat(2049 - 'https://example.com/'.length)}` },
  ],
};

const schemas = [
  ['fields taskFieldDataSchema', taskFieldDataSchema],
  ['factory with tasks primitives', createTaskFieldDataSchema({ calendarDateSchema, minutesSchema })],
] as const;

for (const [name, schema] of schemas) {
  describe(name, () => {
    describe.each(Object.entries(accepted))('accepts %s values', (_kind, cases) => {
      it.each(cases)('%j', (input, expected = input) => {
        expect(schema.parse(input)).toEqual(expected);
      });
    });

    describe.each(Object.entries(rejected))('rejects %s values', (_kind, cases) => {
      it.each(cases)('%j', (input) => {
        expect(schema.safeParse(input).success).toBe(false);
      });
    });

    it('keeps null distinct from empty and zero values', () => {
      expect(schema.parse({ type: 'text', value: '' })).not.toEqual(schema.parse({ type: 'text', value: null }));
      expect(schema.parse({ type: 'number', value: 0 })).not.toEqual(schema.parse({ type: 'number', value: null }));
      expect(schema.parse({ type: 'boolean', value: false })).not.toEqual(
        schema.parse({ type: 'boolean', value: null }),
      );
      expect(schema.parse({ type: 'person', value: [] })).not.toEqual(schema.parse({ type: 'person', value: null }));
    });
  });
}

describe('createTaskFieldDataSchema', () => {
  const fromFactory = createTaskFieldDataSchema({ calendarDateSchema, minutesSchema });
  const allInputs = [
    ...Object.values(accepted).flatMap((cases) => cases.map(([input]) => input)),
    ...Object.values(rejected).flat(),
  ];

  it('matches the public taskFieldDataSchema result and issues for every fixture', () => {
    for (const input of allInputs) {
      const original = taskFieldDataSchema.safeParse(input);
      const rebuilt = fromFactory.safeParse(input);
      expect(rebuilt.success, JSON.stringify(input)).toBe(original.success);
      expect(rebuilt.data, JSON.stringify(input)).toEqual(original.data);
      expect(rebuilt.error?.issues, JSON.stringify(input)).toEqual(original.error?.issues);
    }
  });

  it('validates date and duration values with the injected primitives', () => {
    const strict = createTaskFieldDataSchema({
      calendarDateSchema: sqlCalendarDateSchema,
      minutesSchema: z.number().int().min(0).max(60),
    });

    expect(strict.safeParse({ type: 'date', value: '0000-01-01' }).success).toBe(false);
    expect(strict.parse({ type: 'date', value: '0001-01-01' })).toEqual({ type: 'date', value: '0001-01-01' });
    expect(strict.safeParse({ type: 'duration', value: 61 }).success).toBe(false);
    expect(strict.parse({ type: 'duration', value: 60 })).toEqual({ type: 'duration', value: 60 });
    expect(strict.parse({ type: 'text', value: ' kept ' })).toEqual({ type: 'text', value: ' kept ' });
  });
});
