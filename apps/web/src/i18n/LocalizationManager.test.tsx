import { act, render, screen } from '@testing-library/react';
import { useEffect, useMemo } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initializeLocalization, useTranslation } from './index';
import { catalogsFromModules, LocalizationManager, type TranslationCatalog } from './LocalizationManager';

// The fixture follows the production directory + namespace convention. No registry imports or
// app-wide edits are needed to discover the second locale.
const modules = import.meta.glob<TranslationCatalog>('./__fixtures__/*/*.json', { eager: true, import: 'default' });
const catalogs = catalogsFromModules(modules);

afterEach(() => { localStorage.clear(); document.documentElement.lang = 'en'; });

describe('LocalizationManager JSON resources', () => {
  it('discovers JSON locales and falls back to English for unsupported preferences and missing translations', () => {
    const manager = new LocalizationManager(catalogs);
    expect(manager.availableLocales).toEqual(['de', 'en']);
    expect(manager.getLocale()).toBe('en');
    expect(manager.t('demo.greeting', { name: 'Ava' })).toBe('Hello, Ava');
    manager.setLocale('de-DE');
    expect(manager.getLocale()).toBe('de');
    expect(manager.t('demo.onlyEnglish')).toBe('English fallback');
    expect(manager.t('demo.fallbackTasks', { count: 1 })).toBe('1 task');
    manager.setLocale('not_a_locale');
    expect(manager.getLocale()).toBe('en');
    manager.setLocale('fr');
    expect(manager.getLocale()).toBe('en');
  });

  it('uses locale plural rules and interpolates numbers, zero, false and untrusted text without HTML', () => {
    const manager = new LocalizationManager(catalogs, { locale: 'de' });
    expect(manager.t('demo.tasks', { count: 1 })).toBe('1 Aufgabe');
    expect(manager.t('demo.tasks', { count: 2 })).toBe('2 Aufgaben');
    expect(manager.t('demo.tasks', { count: 0 })).toBe('0 Aufgaben');
    expect(manager.t('demo.emptyValue', { value: false })).toBe('Wert: false');
    expect(manager.t('demo.emptyValue', { value: 0 })).toBe('Wert: 0');
    expect(manager.t('demo.greeting', { name: '<img src=x onerror=alert(1)>' })).toContain('<img');
    render(<p>{manager.t('demo.greeting', { name: '<img src=x onerror=alert(1)>' })}</p>);
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText('Hallo, <img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(manager.formatNumber(1234.5)).toBe('1.234,5');
  });

  it('exposes unknown keys, missing parameters and invalid plural counts with deduplicated diagnostics', () => {
    const onIssue = vi.fn();
    const manager = new LocalizationManager(catalogs, { onIssue });
    expect(manager.t('demo.missing')).toBe('⟦demo.missing⟧');
    expect(manager.t('demo.missing')).toBe('⟦demo.missing⟧');
    expect(onIssue).toHaveBeenCalledTimes(1);
    expect(manager.t('demo.greeting')).toBe('Hello, {{name}}');
    expect(manager.t('demo.tasks', { count: '2' })).toBe('⟦demo.tasks:count⟧');
    expect(onIssue.mock.calls.map(([issue]) => issue.kind)).toEqual(['missing-key', 'missing-parameter', 'invalid-count']);
    expect(onIssue).toHaveBeenCalledWith({ kind: 'missing-parameter', key: 'demo.greeting', locale: 'en', parameter: 'name' });
  });

  it('rejects malformed catalogs with exact resource diagnostics and rejects translated parameter drift', () => {
    expect(() => catalogsFromModules({ './de/demo.json': { greeting: null } })).toThrow('de:demo.greeting');
    expect(() => new LocalizationManager({ en: { demo: { 'group.name': 'One', group: { name: 'Two' } } } })).toThrow('Duplicate localization key');
    expect(() => catalogsFromModules({ './en/demo.json': { tasks: { one: 'One task' } } })).toThrow('plural messages require');
    expect(() => catalogsFromModules({ './en/demo.json': { greeting: 'Hello {{name' } })).toThrow('malformed interpolation');
    expect(() => new LocalizationManager({ en: { demo: { greeting: 'Hello {{name}}' } }, de: { demo: { greeting: 'Hallo {{user}}' } } })).toThrow('de:demo.greeting: interpolation parameters differ');
    expect(() => new LocalizationManager({ en: { demo: { tasks: { one: '{{count}} task', other: '{{count}} tasks' } } }, de: { demo: { tasks: 'Aufgaben' } } })).toThrow('message shape differs');
    expect(() => new LocalizationManager({ en: { demo: { greeting: 'Hello' } }, de: { demo: { extra: 'Extra' } } })).toThrow('no English source message');
  });

  it('formats calendar-only dates without shifting the date into a different time zone', () => {
    const manager = new LocalizationManager(catalogs);
    const options = { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' } as const;
    expect(manager.formatDate('2026-10-16', options)).toBe('10/16/2026');
    manager.setLocale('de');
    expect(manager.formatDate('2026-10-16', options)).toBe('16.10.2026');
    expect(manager.formatDate('2026-10-16T00:00:00Z', options)).toBe('15.10.2026');
  });

  it('switches subscribed React text, memoized output, number/date formatting, document lang and title', () => {
    const manager = new LocalizationManager(catalogs);
    const unsubscribe = initializeLocalization(manager);
    function Example() {
      const { t, formatDate, formatNumber } = useTranslation(manager);
      const greeting = useMemo(() => t('demo.greeting', { name: 'Ava' }), [t]);
      const number = useMemo(() => formatNumber(1234.5), [formatNumber]);
      const date = useMemo(() => formatDate('2026-10-16', { dateStyle: 'long' }), [formatDate]);
      useEffect(() => { document.title = t('demo.title', { title: 'Tasks' }); }, [t]);
      return <><p>{greeting}</p><p>{number}</p><p>{date}</p></>;
    }
    const view = render(<Example />);
    expect(screen.getByText('Hello, Ava')).toBeInTheDocument();
    expect(screen.getByText('1,234.5')).toBeInTheDocument();
    expect(screen.getByText('October 16, 2026')).toBeInTheDocument();
    expect(document.title).toBe('Tasks · Demo');
    act(() => manager.setLocale('de'));
    expect(screen.getByText('Hallo, Ava')).toBeInTheDocument();
    expect(screen.getByText('1.234,5')).toBeInTheDocument();
    expect(screen.getByText('16. Oktober 2026')).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('de');
    expect(document.title).toBe('Tasks · Beispiel');
    expect(localStorage.getItem('workloom.locale')).toBe('de');
    view.unmount(); unsubscribe();
  });

  it('uses a saved supported choice and works when browser storage is unavailable', () => {
    localStorage.setItem('workloom.locale', 'de');
    const manager = new LocalizationManager(catalogs);
    const unsubscribe = initializeLocalization(manager);
    expect(manager.getLocale()).toBe('de');
    unsubscribe();
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Unavailable'); });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Unavailable'); });
    try {
      const fallback = new LocalizationManager(catalogs);
      const stop = initializeLocalization(fallback);
      expect(fallback.getLocale()).toBe('en');
      stop();
    } finally { getItem.mockRestore(); setItem.mockRestore(); }
  });
});
