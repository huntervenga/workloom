import type { TaskFieldData, TaskFieldDefinitionDto, TaskFieldType } from '@workloom/contracts';
import { describe, expect, it } from 'vitest';
import { draftFromFieldValue, formatFieldNumber, parseFieldDraft, type FieldDraft } from './valueDraft';

const OPTION_A = '0b6f4f8e-1d6a-4b8a-9f1e-1a2b3c4d5e01';
const OPTION_B = '0b6f4f8e-1d6a-4b8a-9f1e-1a2b3c4d5e02';

function makeField(type: TaskFieldType): TaskFieldDefinitionDto {
  return {
    id: '5f0c2c1e-7a1b-4c3d-8e9f-000000000001',
    workspaceId: '5f0c2c1e-7a1b-4c3d-8e9f-000000000002',
    projectId: '5f0c2c1e-7a1b-4c3d-8e9f-000000000003',
    name: 'Поле',
    type,
    revision: 1,
    definitionVersionId: '5f0c2c1e-7a1b-4c3d-8e9f-000000000004',
    historyEnabled: true,
    locked: false,
    archivedAt: null,
    options: [],
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
}

function roundTrip(value: TaskFieldData) {
  const field = makeField(value.type);
  return parseFieldDraft(field, draftFromFieldValue(field, value));
}

function parse(type: TaskFieldType, draft: FieldDraft) {
  return parseFieldDraft(makeField(type), draft);
}

describe('field value drafts', () => {
  it('keeps an explicit clear apart from false, 0, [] and empty text', () => {
    const values: TaskFieldData[] = [
      { type: 'boolean', value: false },
      { type: 'number', value: 0 },
      { type: 'duration', value: 0 },
      { type: 'multi_select', value: [] },
      { type: 'person', value: [] },
      { type: 'text', value: '' },
    ];
    for (const value of values) {
      expect(roundTrip(value)).toEqual({ ok: true, value });
      expect(roundTrip({ ...value, value: null } as TaskFieldData)).toEqual({ ok: true, value: { type: value.type, value: null } });
    }
    // A blank number or duration field is a clear, never zero.
    expect(parse('number', { type: 'number', text: '  ' })).toEqual({ ok: true, value: { type: 'number', value: null } });
    expect(parse('duration', { type: 'duration', text: '' })).toEqual({ ok: true, value: { type: 'duration', value: null } });
  });

  it('parses durations exactly with the shared hours parser and refuses rounding', () => {
    expect(parse('duration', { type: 'duration', text: '1,5' })).toEqual({ ok: true, value: { type: 'duration', value: 90 } });
    expect(parse('duration', { type: 'duration', text: '0:05' })).toEqual({ ok: true, value: { type: 'duration', value: 5 } });
    expect(parse('duration', { type: 'duration', text: '0,35' })).toEqual({ ok: true, value: { type: 'duration', value: 21 } });

    for (const text of ['0,01', '1.333', '-1', '1:75', 'час']) {
      const result = parse('duration', { type: 'duration', text });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).not.toMatch(/оценк/i);
    }
    expect(roundTrip({ type: 'duration', value: 61 })).toEqual({ ok: true, value: { type: 'duration', value: 61 } });
  });

  it('accepts decimal numbers with comma or dot and never turns garbage into zero', () => {
    expect(parse('number', { type: 'number', text: '3,5' })).toEqual({ ok: true, value: { type: 'number', value: 3.5 } });
    expect(parse('number', { type: 'number', text: '−2.25' })).toEqual({ ok: true, value: { type: 'number', value: -2.25 } });
    for (const text of ['abc', '1e3', '1,2,3', '0x10', 'Infinity', '12 штук']) {
      expect(parse('number', { type: 'number', text }).ok).toBe(false);
    }
    expect(parse('number', { type: 'number', text: '1000000000001' }).ok).toBe(false);
    // Tiny stored numbers come back as plain digits, not exponent notation the input rejects.
    expect(roundTrip({ type: 'number', value: 1.5e-7 })).toEqual({ ok: true, value: { type: 'number', value: 1.5e-7 } });
    expect(formatFieldNumber(-1234567.5)).toMatch(/^−1\s234\s567,5$/);
    expect(formatFieldNumber(0.1 + 0.2)).toBe('0,30000000000000004');
    for (const value of [0.1 + 0.2, 1.0000000000000002, Number.MIN_VALUE]) {
      expect(roundTrip({ type: 'number', value })).toEqual({ ok: true, value: { type: 'number', value } });
    }
  });

  it('accepts only http and https links', () => {
    expect(parse('url', { type: 'url', text: ' https://example.test/a ' })).toEqual({
      ok: true,
      value: { type: 'url', value: 'https://example.test/a' },
    });
    expect(parse('url', { type: 'url', text: '' })).toEqual({ ok: true, value: { type: 'url', value: null } });
    for (const text of ['javascript:alert(1)', 'data:text/html,x', '//example.test', 'https://user:pw@example.test']) {
      expect(parse('url', { type: 'url', text }).ok).toBe(false);
    }
  });

  it('canonicalizes reference sets without dropping unknown IDs', () => {
    const result = parse('multi_select', { type: 'multi_select', value: [OPTION_B.toUpperCase(), OPTION_A, OPTION_B] });
    expect(result).toEqual({ ok: true, value: { type: 'multi_select', value: [OPTION_A, OPTION_B] } });
    expect(parse('person', { type: 'person', value: ['not-an-id'] }).ok).toBe(false);
  });

  it('rejects a draft of another type and validates dates as calendar dates', () => {
    expect(parse('number', { type: 'text', value: '1' }).ok).toBe(false);
    expect(parse('date', { type: 'date', text: '2026-02-30' }).ok).toBe(false);
    expect(parse('date', { type: 'date', text: '2026-02-28' })).toEqual({ ok: true, value: { type: 'date', value: '2026-02-28' } });
  });
});
