import { describe, expect, it } from 'vitest';
import { buildImportMapping, formFromMapping, peopleValues, referenceChoice } from './mapping';
import { durationField, mapping, source, STATUS_ID } from './test/fixtures';

describe('explicit CSV mapping', () => {
  it('does not treat inherited prototype names as selected people, but accepts explicit literal choices', () => {
    const staged = source();
    staged.headers.push('Responsible');
    staged.sourceRows = ['constructor', '__proto__', ' toString '].map((name, index) => ({ rowNumber: index + 1, cells: [`000${index}`, 'Task', '1', '', name] }));
    const form = formFromMapping(mapping()); form.columns.responsibleColumn = 4;
    expect(peopleValues(staged, form)).toEqual(['__proto__', 'constructor', 'toString']);
    expect(referenceChoice(form.people, 'constructor')).toBe('');
    expect(buildImportMapping(staged, form, [durationField()])?.people).toEqual([]);
    form.people = Object.fromEntries(peopleValues(staged, form).map(name => [name, STATUS_ID]));
    expect(buildImportMapping(staged, form, [durationField()])?.people).toEqual([
      { sourceValue: '__proto__', membershipId: STATUS_ID }, { sourceValue: 'constructor', membershipId: STATUS_ID }, { sourceValue: 'toString', membershipId: STATUS_ID },
    ]);
    expect(staged.sourceRows[0]?.cells[0]).toBe('0000');
  });
  it('retains current snapshot meaning and source units when confirmed mapping is reopened', () => {
    const saved = mapping(); const field = saved.customFields[0]; if (!field) throw new Error('Expected mapped field'); saved.customFields[0] = { ...field, sourceMeaning: 'current_actual', sourceUnit: 'hours' };
    const restored = buildImportMapping(source(), formFromMapping(saved), [durationField()]);
    expect(restored).toEqual(saved);
    expect(restored?.customFields[0]).toMatchObject({ sourceMeaning: 'current_actual', sourceUnit: 'hours' });
    expect(source().sourceRows[0]?.cells[0]).toBe('000900719925474099312345');
  });
});
