import { describe, expect, it } from 'vitest';
import { overview } from '../test/fixtures';
import { parseCsv } from './csv';
import { normalizeDate, readAbsenceTable, resolveAbsences, unmatchedNames } from './absenceRows';

describe('CSV reading', () => {
  it('reads quotes, doubled quotes, line breaks inside a field, CRLF and a BOM', () => {
    expect(parseCsv('﻿Person,Note\r\n"Ann, Jr.","said ""hi""\nthere"\r\nBob,\r\n')).toEqual([['Person', 'Note'], ['Ann, Jr.', 'said "hi"\nthere'], ['Bob', '']]);
  });
  it('detects semicolons and tabs as the delimiter', () => {
    expect(parseCsv('a;b;c\n1;2;3')).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
    expect(parseCsv('a\tb\n1\t2')).toEqual([['a', 'b'], ['1', '2']]);
  });
});

describe('absence rows', () => {
  it('accepts ISO and dotted dates and refuses ambiguous or impossible ones', () => {
    expect(normalizeDate('2026-07-06')).toBe('2026-07-06');
    expect(normalizeDate('6.7.2026')).toBe('2026-07-06');
    expect(normalizeDate('06/07/2026')).toBeNull();
    expect(normalizeDate('2026-02-30')).toBeNull();
    expect(normalizeDate('')).toBeNull();
  });
  it('finds the columns by title, treats a missing end as one day and flags bad rows', () => {
    const table = readAbsenceTable(parseCsv('Employee,Leave type,From,To,Comment\nAnna,Vacation,2026-07-06,2026-07-10,Trip\nAnna,Vacation,2026-07-20,,\nAnna,Vacation,2026-07-20,,\nBob,Vacation,10.07.2026,06.07.2026,\nBob,Vacation,soon,,'));
    expect(table.missingColumns).toEqual([]);
    expect(table.rows.map(row => [row.line, row.startDate, row.endDate, row.issues])).toEqual([
      [2, '2026-07-06', '2026-07-10', []], [3, '2026-07-20', '2026-07-20', []], [4, '2026-07-20', '2026-07-20', ['duplicate']],
      [5, '2026-07-10', '2026-07-06', ['order']], [6, null, null, ['startDate', 'endDate']],
    ]);
    expect(readAbsenceTable(parseCsv('Name,When\nAnna,today')).missingColumns).toEqual(['type', 'start', 'end']);
  });
  it('matches people and leave types by name, lets the person fix the rest, and skips rows already recorded', () => {
    const data = overview();
    const [first, second] = data.members;
    const vacation = data.settings?.policyVersions[0]?.types[0];
    if (!first || !second || !vacation) throw new Error('fixture');
    const table = readAbsenceTable(parseCsv(`Person,Type,Start,End\n${first.displayName.toUpperCase()},${vacation.name},2026-07-06,2026-07-10\nGhost,${vacation.name},2026-07-06,2026-07-10\n${second.displayName},Sabbatical,2026-07-06,2026-07-10`));
    const resolved = resolveAbsences(table.rows, data);
    expect(resolved.map(row => row.status)).toEqual(['ready', 'invalid', 'invalid']);
    expect(unmatchedNames(resolved)).toEqual({ people: ['Ghost'], types: ['Sabbatical'] });
    const fixed = resolveAbsences(table.rows, data, { people: { ghost: first.id }, types: { sabbatical: vacation.id } });
    expect(fixed.map(row => row.status)).toEqual(['ready', 'ready', 'ready']);
    const already = resolveAbsences(table.rows, { ...data, requests: [{ membershipId: first.id, typeId: vacation.id, startDate: '2026-07-06', endDate: '2026-07-10', status: 'approved' } as unknown as (typeof data.requests)[number]] });
    expect(already[0]?.status).toBe('exists');
    // Choosing "Skip rows" again (an empty choice) leaves the row unmatched instead of ready with an empty person.
    const skipped = resolveAbsences(table.rows, data, { people: { ghost: '' }, types: { sabbatical: '' } });
    expect(skipped.map(row => row.status)).toEqual(['ready', 'invalid', 'invalid']);
    expect(skipped[1]?.membershipId).toBeNull();
  });
});
