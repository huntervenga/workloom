import { useMemo, useSyncExternalStore } from 'react';
import { LocalizationManager, catalogsFromModules, type TranslationCatalog } from './LocalizationManager';
export { LocalizationManager } from './LocalizationManager';
export { message, type TranslationMessage } from './messages';
export type { TranslationKey, TranslationParameters, TranslationCatalog, LocalizationIssue } from './LocalizationManager';

// Adding a locale directory and JSON namespaces automatically includes it in the next bundle.
const modules = import.meta.glob<TranslationCatalog>('./locales/*/*.json', { eager: true, import: 'default' });
const catalogs = catalogsFromModules(modules);
export const localization = new LocalizationManager(catalogs);
export const t = localization.t;
export const formatDate = localization.formatDate;
export const formatNumber = localization.formatNumber;

/** No provider is required: isolated component tests and route chunks share the same manager. */
export function useTranslation(manager: LocalizationManager = localization) {
  const locale = useSyncExternalStore(manager.subscribe, manager.getLocale, manager.getLocale);
  return useMemo(() => ({
    t: (key: Parameters<typeof manager.t>[0], parameters?: Parameters<typeof manager.t>[1]) => manager.t(key, parameters, locale),
    locale,
    setLocale: manager.setLocale,
    formatDate: (value: Parameters<typeof manager.formatDate>[0], options?: Intl.DateTimeFormatOptions) => manager.formatDate(value, options, locale),
    formatNumber: (value: number, options?: Intl.NumberFormatOptions) => manager.formatNumber(value, options, locale),
    availableLocales: manager.availableLocales,
  }), [manager, locale]);
}

/** English is the initial default; only an explicit saved selection changes it. */
export function initializeLocalization(manager: LocalizationManager = localization): () => void {
  try {
    const saved = localStorage.getItem('workloom.locale');
    if (saved) manager.setLocale(saved);
  } catch { /* Browser storage may be unavailable; the documented English default still works. */ }
  const apply = () => {
    document.documentElement.lang = manager.getLocale();
    try { localStorage.setItem('workloom.locale', manager.getLocale()); } catch { /* Storage is optional. */ }
  };
  apply();
  return manager.subscribe(apply);
}
