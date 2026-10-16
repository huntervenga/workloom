import type { TaskFieldData, TaskFieldDefinitionDto, TaskFieldType } from '@workloom/contracts';
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as I18n from '../../i18n';
import type { LocalizationManager, TranslationCatalog } from '../../i18n/LocalizationManager';
import { FieldInput } from './FieldInput';
import { FieldValueDisplay } from './FieldValueDisplay';
import { draftFromFieldValue, formatFieldNumber, parseFieldDraft } from './valueDraft';

const state = vi.hoisted(() => ({ manager: undefined as LocalizationManager | undefined }));
vi.mock('../../i18n', async importOriginal => {
  const actual = await importOriginal<typeof I18n>();
  const resources = import.meta.glob<TranslationCatalog>('../../i18n/locales/en/*.json', { eager: true, import: 'default' });
  const en = Object.fromEntries(Object.entries(resources).map(([path, catalog]) => [path.slice(path.lastIndexOf('/') + 1).replace('.json', ''), catalog]));
  // Real managers with additional supported locales; absent messages use the English catalogs.
  const manager = new actual.LocalizationManager({ en, de: {}, 'ar-EG': {} });
  state.manager = manager;
  return { ...actual, localization: manager, t: manager.t, formatDate: manager.formatDate, formatNumber: manager.formatNumber, useTranslation: () => actual.useTranslation(manager) };
});
afterEach(() => { act(() => state.manager?.setLocale('en')); });

function switchLocale(locale: string) { act(() => state.manager?.setLocale(locale)); }

function field(type: TaskFieldType): TaskFieldDefinitionDto {
  return {
    id: '5f0c2c1e-7a1b-4c3d-8e9f-000000000001',
    workspaceId: '5f0c2c1e-7a1b-4c3d-8e9f-000000000002',
    projectId: '5f0c2c1e-7a1b-4c3d-8e9f-000000000003',
    definitionVersionId: '5f0c2c1e-7a1b-4c3d-8e9f-000000000004',
    name: 'Stored field name', type, revision: 1, historyEnabled: true, locked: false,
    archivedAt: null, options: [], createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
  };
}

describe('localized read-only custom-field values', () => {
  it('updates the same date and number displays while preserving ISO dates, stored values and raw input', () => {
    const dateField = field('date');
    const numberField = field('number');
    const date: TaskFieldData = { type: 'date', value: '2026-01-01' };
    const number: TaskFieldData = { type: 'number', value: -1234.56 };
    const dateDraft = draftFromFieldValue(dateField, date);
    const numberDraft = { type: 'number' as const, text: ' -1234,5600 ' };
    const original = structuredClone({ date, number, dateDraft, numberDraft });
    const onChange = vi.fn();
    const view = render(<>
      <FieldValueDisplay field={dateField} value={date} members={[]} />
      <FieldValueDisplay field={numberField} value={number} members={[]} />
      <FieldInput field={numberField} draft={numberDraft} members={[]} originalValue={number} onChange={onChange} />
    </>);
    const calendar = view.container.querySelector('time');
    const input = screen.getByRole('textbox', { name: 'Stored field name' });
    expect(calendar).toHaveTextContent('01/01/2026');
    expect(calendar).toHaveAttribute('dateTime', '2026-01-01');
    expect(screen.getByText('−1,234.56')).toBeVisible();
    input.focus();
    switchLocale('de');
    expect(view.container.querySelector('time')).toBe(calendar);
    expect(calendar).toHaveTextContent('01.01.2026');
    expect(calendar).toHaveAttribute('dateTime', '2026-01-01');
    expect(screen.getByText('−1.234,56')).toBeVisible();
    expect(input).toHaveValue(' -1234,5600 ');
    expect(input).toHaveFocus();
    switchLocale('en');
    expect(calendar).toHaveTextContent('01/01/2026');
    expect(screen.getByText('−1,234.56')).toBeVisible();
    expect({ date, number, dateDraft, numberDraft }).toEqual(original);
    expect(parseFieldDraft(numberField, numberDraft)).toEqual({ ok: true, value: number });
    expect(parseFieldDraft(dateField, dateDraft)).toEqual({ ok: true, value: date });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps boundary calendar days and refuses hostile malformed dates without throwing', () => {
    const dateField = field('date');
    for (const [iso, en, de] of [
      ['2025-12-31', '12/31/2025', '31.12.2025'],
      ['2026-01-01', '01/01/2026', '01.01.2026'],
      ['2028-02-29', '02/29/2028', '29.02.2028'],
    ] as const) {
      switchLocale('en');
      const view = render(<FieldValueDisplay field={dateField} value={{ type: 'date', value: iso }} members={[]} />);
      expect(view.container.querySelector('time')).toHaveTextContent(en);
      switchLocale('de');
      expect(view.container.querySelector('time')).toHaveTextContent(de);
      expect(view.container.querySelector('time')).toHaveAttribute('dateTime', iso);
      view.unmount();
    }
    for (const value of ['2026-02-30', '2026-99-99', '10000-01-01', '2026-01-01T00:00:00Z']) {
      const view = render(<FieldValueDisplay field={dateField} value={{ type: 'date', value }} members={[]} />);
      expect(screen.getByText('Value unavailable')).toBeVisible();
      expect(view.container.querySelector('time')).toBeNull();
      view.unmount();
    }
  });

  it('localizes every Arabic digit without rounding decimals or changing ASCII editable drafts', () => {
    const numberField = field('number');
    const samples = [
      [1234.56, '١٬٢٣٤٫٥٦'],
      [-1234.56, '−١٬٢٣٤٫٥٦'],
      [0, '٠'],
      [-0, '٠'],
      [0.1 + 0.2, '٠٫٣٠٠٠٠٠٠٠٠٠٠٠٠٠٠٠٤'],
      [1.0000000000000002, '١٫٠٠٠٠٠٠٠٠٠٠٠٠٠٠٠٢'],
      [1.5e-7, '٠٫٠٠٠٠٠٠١٥'],
      [Number.MIN_VALUE, `٠٫${'٠'.repeat(323)}٥`],
    ] as const;
    switchLocale('ar-EG');
    for (const [value, expected] of samples) {
      expect(formatFieldNumber(value)).toBe(expected);
      const stored: TaskFieldData = { type: 'number', value };
      const draft = draftFromFieldValue(numberField, stored);
      expect(draft.type === 'number' && draft.text).toMatch(/^-?[0-9]+(?:\.[0-9]+)?$/);
      expect(parseFieldDraft(numberField, draft)).toEqual({ ok: true, value: { type: 'number', value: Object.is(value, -0) ? 0 : value } });
    }
    const value: TaskFieldData = { type: 'number', value: -1234.56 };
    render(<FieldValueDisplay field={numberField} value={value} members={[]} />);
    expect(screen.getByText('−١٬٢٣٤٫٥٦')).toBeVisible();
    switchLocale('en');
    expect(screen.getByText('−1,234.56')).toBeVisible();
    expect(value).toEqual({ type: 'number', value: -1234.56 });
  });
});
