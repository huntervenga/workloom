import { describe, expect, it } from 'vitest';
import { assertUniqueJsonKeys, auditUiSource, callTranslationKeys, tableTranslationKeys } from '../../../../scripts/localization-audit';

const englishKeys = new Set(['common.save', 'common.cancel', 'common.loading']);
const check = (source: string) => auditUiSource(source, 'fixture.tsx', { englishKeys }).diagnostics;

describe('UI localization syntax audit', () => {
  it('rejects duplicate raw JSON properties before JSON.parse can discard them', () => {
    expect(() => assertUniqueJsonKeys('{"save":"Save","save":"Other"}', 'en/common.json')).toThrow('Duplicate JSON property in en/common.json: save');
    expect(() => assertUniqueJsonKeys('{"a":{"label":"Save"},"b":{"label":"Cancel"}}', 'en/common.json')).not.toThrow();
  });

  it('catches English and Russian JSX, attributes, errors, templates and single-word label dictionaries', () => {
    const cases = [
      'function Page() { return <button>Save</button>; }',
      'function Page() { return <button>Сохранить</button>; }',
      'function Page() { return <input aria-label="Search" placeholder="Find tasks" />; }',
      'function Page() { return <p>{"Archived"}</p>; }',
      'const priorityLabels = { low: "Low", high: "High" };',
      'const classLabels = { low: "Low" };',
      'function save() { throw new Error("Unable to save"); }',
      'function save() { setError("Failure"); }',
      'function title(name: string) { return `Project ${name}`; }',
    ];
    for (const source of cases) expect(check(source), source).not.toEqual([]);
  });

  it('does not confuse stable values, CSS and translated expressions with UI prose', () => {
    const source = `function Page() { const { t } = useTranslation(); return <button type="button" className="flex items-center gap-2 text-sm" aria-label={t('common.save')}>{t('common.save')}{status === 'done' ? t('common.cancel') : null}</button>; }`;
    expect(check(source)).toEqual([]);
    expect(check('const labels = { get save() { return t("common.save"); } };')).toEqual([]);
  });

  it('fails missing keys, unexplained dynamic keys and module-scope translated snapshots', () => {
    expect(check('function Page() { return t("common.typo"); }')).toEqual([expect.objectContaining({ kind: 'missing English key', text: 'common.typo' })]);
    expect(check('function Page(key: string) { return t(key); }')).toEqual([expect.objectContaining({ kind: 'unexplained dynamic translation key', text: 'key' })]);
    expect(check('const label = t("common.save");')).toEqual([expect.objectContaining({ kind: 'module-scope translation snapshot' })]);
    expect(check('const label = message("common.save");')).toEqual([]);
    expect(check('const label = message("common.typo");')).toEqual([expect.objectContaining({ kind: 'missing English key', text: 'common.typo' })]);
  });

  it('checks all finite conditional aliases and explicitly audited dynamic tables', () => {
    expect(check('function Page() { const message = pending ? "common.save" : "common.typo"; return t(message); }')).toEqual([expect.objectContaining({ kind: 'missing English key', text: 'common.typo' })]);
    const source = 'function Page(label: string) { return t(label); }';
    expect(auditUiSource(source, 'fixture.tsx', { englishKeys, dynamicKeys: new Map([['label', { keys: ['common.save', 'common.cancel'], reason: 'Finite named table' }]]) }).diagnostics).toEqual([]);
    expect(auditUiSource(source, 'fixture.tsx', { englishKeys, dynamicKeys: new Map([['label', { keys: ['common.typo'], reason: 'Finite named table' }]]) }).diagnostics).toEqual([expect.objectContaining({ kind: 'missing English key' })]);
    expect(auditUiSource(source, 'fixture.tsx', { englishKeys, dynamicKeys: new Map([['label', { keys: ['common.save'], reason: '' }]]) }).diagnostics).toEqual([expect.objectContaining({ kind: 'unexplained dynamic translation key' })]);
  });

  it('extracts actual table/caller keys and rejects dynamic additions', () => {
    expect(tableTranslationKeys('const labels = [[1, "common.save"], [2, "common.cancel"]] as const;', 'labels', 1)).toEqual(['common.save', 'common.cancel']);
    expect(tableTranslationKeys('const labels = { save: "common.save", cancel: "common.cancel" } as const;', 'labels')).toEqual(['common.save', 'common.cancel']);
    expect(() => tableTranslationKeys('const labels = { save: arbitraryKey };', 'labels')).toThrow('Nonliteral translation key');
    expect(callTranslationKeys('const page = createAsyncRoute(load, "common.loading");', 'createAsyncRoute', 1)).toEqual(['common.loading']);
    expect(() => callTranslationKeys('createAsyncRoute(load, arbitraryKey);', 'createAsyncRoute', 1)).toThrow('Nonliteral translation key');
    expect(callTranslationKeys('setValidation(null); setValidation(""); setValidation("common.save");', 'setValidation', 0, true)).toEqual(['common.save']);
    expect(callTranslationKeys('function Page() { return <button onClick={() => setValidation("common.save")}>Save</button>; }', 'setValidation', 0)).toEqual(['common.save']);
    expect(callTranslationKeys('throw new LocalError("common.save");', 'LocalError', 0, false, true)).toEqual(['common.save']);
    expect(() => callTranslationKeys('throw new LocalError(dynamic);', 'LocalError', 0, false, true)).toThrow('Nonliteral translation key');
    expect(callTranslationKeys('issue(estimate.messageKey);', 'issue', 0, false, false, new Map([['estimate.messageKey', ['common.save']]]))).toEqual(['common.save']);
    expect(() => callTranslationKeys('issue(unreviewed.key);', 'issue', 0, false, false, new Map([['estimate.messageKey', ['common.save']]]))).toThrow('Nonliteral translation key');

  });

  it('requires an exact exemption and leaves unrelated new copy visible to review', () => {
    const source = 'function save() { throw new Error("Developer invariant"); } function load() { throw new Error("Unknown error"); }';
    const result = auditUiSource(source, 'fixture.tsx', { englishKeys, literalExemptions: new Map([['Developer invariant', 'Fixed safe copy is rendered by an error boundary.']]) });
    expect(result.diagnostics).toEqual([expect.objectContaining({ text: 'Unknown error' })]);
  });
});
