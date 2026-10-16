/** Text is always returned as plain text. React, never this manager, owns HTML escaping. */
export type TranslationParameters = Readonly<Record<string, string | number | boolean | null | undefined>>;
export type TranslationKey = `${string}.${string}`;
export interface TranslationCatalog { readonly [key: string]: string | TranslationCatalog }
export type LocaleCatalogs = Readonly<Record<string, Readonly<Record<string, TranslationCatalog>>>>;
export type LocalizationIssue = { kind: 'missing-key' | 'missing-parameter' | 'invalid-count'; key: string; locale: string; parameter?: string };
export interface LocalizationOptions {
  fallbackLocale?: string;
  locale?: string;
  onIssue?: (issue: LocalizationIssue) => void;
}
const pluralCategories = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);
const parameterPattern = /{{\s*([A-Za-z][\w]*)\s*}}/g;

export function isPluralMessage(value: string | TranslationCatalog): value is TranslationCatalog {
  return typeof value !== 'string' && typeof value.other === 'string' && Object.keys(value).every((key) => pluralCategories.has(key) && typeof value[key] === 'string');
}

export function catalogMessages(catalog: TranslationCatalog, prefix = ''): Map<string, string | TranslationCatalog> {
  const result = new Map<string, string | TranslationCatalog>();
  for (const [key, value] of Object.entries(catalog)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string' || isPluralMessage(value)) {
      if (result.has(path)) throw new Error(`Duplicate localization key: ${path}`);
      result.set(path, value);
    } else for (const [nestedKey, nestedValue] of catalogMessages(value, path)) {
      if (result.has(nestedKey)) throw new Error(`Duplicate localization key: ${nestedKey}`);
      result.set(nestedKey, nestedValue);
    }
  }
  return result;
}

function messageParameters(value: string | TranslationCatalog): string[] {
  const values = typeof value === 'string' ? [value] : Object.values(value) as string[];
  return [...new Set(values.flatMap((text) => [...text.matchAll(parameterPattern)].map((match) => match[1] as string)))].sort();
}

/** Reject invalid resource shapes at startup, with the exact locale and key in the diagnostic. */
export function validateCatalog(catalog: unknown, path: string): asserts catalog is TranslationCatalog {
  if (typeof catalog !== 'object' || catalog === null || Array.isArray(catalog)) throw new Error(`Invalid localization catalog ${path}: expected an object`);
  const entries = Object.entries(catalog);
  if (entries.length === 0) throw new Error(`Invalid localization catalog ${path}: empty message group`);
  const isPlural = entries.some(([key]) => pluralCategories.has(key)) && entries.every(([key]) => pluralCategories.has(key));
  if (isPlural && (!Object.hasOwn(catalog, 'other') || entries.some(([, value]) => typeof value !== 'string'))) {
    throw new Error(`Invalid localization catalog ${path}: plural messages require a string "other" form and string forms`);
  }
  for (const [key, value] of entries) {
    const location = `${path}.${key}`;
    if (!key || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(key)) throw new Error(`Invalid localization catalog ${location}: invalid message key`);
    if (typeof value === 'string') {
      if (!value.trim()) throw new Error(`Invalid localization catalog ${location}: empty message`);
      const withoutParameters = value.replace(parameterPattern, '');
      if (withoutParameters.includes('{{') || withoutParameters.includes('}}')) throw new Error(`Invalid localization catalog ${location}: malformed interpolation`);
    } else validateCatalog(value, location);
  }
}

/** Shared by Vite's eager JSON discovery and isolated tests with fixture resources. */
export function catalogsFromModules(modules: Readonly<Record<string, unknown>>): LocaleCatalogs {
  const result: Record<string, Record<string, TranslationCatalog>> = {};
  for (const [path, catalog] of Object.entries(modules)) {
    const match = /(?:^|\/)([^/]+)\/([^/]+)\.json$/.exec(path);
    const locale = match?.[1];
    const namespace = match?.[2];
    if (!locale || !namespace) throw new Error(`Invalid locale resource path: ${path}`);
    Intl.getCanonicalLocales(locale);
    validateCatalog(catalog, `${locale}:${namespace}`);
    const namespaces = result[locale] ??= {};
    if (Object.hasOwn(namespaces, namespace)) throw new Error(`Duplicate locale namespace: ${locale}:${namespace}`);
    namespaces[namespace] = catalog;
  }
  return result;
}

/** An observable, browser-independent manager; tests can create isolated instances. */
export class LocalizationManager {
  readonly fallbackLocale: string;
  readonly availableLocales: readonly string[];
  private locale: string;
  private readonly messages = new Map<string, Map<string, string | TranslationCatalog>>();
  private readonly listeners = new Set<() => void>();
  private readonly reported = new Set<string>();
  private readonly onIssue: (issue: LocalizationIssue) => void;

  constructor(catalogs: LocaleCatalogs, options: LocalizationOptions = {}) {
    this.fallbackLocale = options.fallbackLocale ?? 'en';
    if (!catalogs[this.fallbackLocale]) throw new Error(`Missing fallback locale: ${this.fallbackLocale}`);
    this.availableLocales = Object.freeze(Object.keys(catalogs).sort());
    for (const [locale, namespaces] of Object.entries(catalogs)) {
      Intl.getCanonicalLocales(locale);
      const messages = new Map<string, string | TranslationCatalog>();
      for (const [namespace, catalog] of Object.entries(namespaces)) {
        validateCatalog(catalog, `${locale}:${namespace}`);
        for (const [key, value] of catalogMessages(catalog, namespace)) {
          if (messages.has(key)) throw new Error(`Duplicate localization key: ${locale}:${key}`);
          messages.set(key, value);
        }
      }
      this.messages.set(locale, messages);
    }
    const fallback = this.messages.get(this.fallbackLocale) as Map<string, string | TranslationCatalog>;
    for (const [locale, messages] of this.messages) {
      if (locale === this.fallbackLocale) continue;
      for (const [key, message] of messages) {
        const original = fallback.get(key);
        if (!original) throw new Error(`Invalid localization catalog ${locale}:${key}: no English source message`);
        if (typeof message !== typeof original || isPluralMessage(message) !== isPluralMessage(original)) throw new Error(`Invalid localization catalog ${locale}:${key}: message shape differs from English`);
        if (JSON.stringify(messageParameters(message)) !== JSON.stringify(messageParameters(original))) throw new Error(`Invalid localization catalog ${locale}:${key}: interpolation parameters differ from English`);
      }
    }
    this.locale = this.resolveLocale(options.locale) ?? this.fallbackLocale;
    this.onIssue = options.onIssue ?? ((issue) => console.error(`[localization:${issue.kind}] ${issue.locale}:${issue.key}${issue.parameter ? ` (${issue.parameter})` : ''}`));
  }

  /** Resolve only registered resources; unsupported preferences always use English. */
  resolveLocale = (requested: string | null | undefined): string | null => {
    if (!requested) return null;
    let canonical: string;
    try { canonical = Intl.getCanonicalLocales(requested)[0] ?? ''; } catch { return null; }
    const exact = this.availableLocales.find((locale) => locale.toLowerCase() === canonical.toLowerCase());
    if (exact) return exact;
    const base = canonical.split('-')[0];
    return this.availableLocales.find((locale) => locale.toLowerCase() === base?.toLowerCase()) ?? null;
  };

  getLocale = (): string => this.locale;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  setLocale = (requested: string): void => {
    const next = this.resolveLocale(requested) ?? this.fallbackLocale;
    if (next === this.locale) return;
    this.locale = next;
    this.reported.clear();
    for (const listener of this.listeners) listener();
  };

  private report(issue: LocalizationIssue): void {
    const id = JSON.stringify(issue);
    if (this.reported.has(id)) return;
    this.reported.add(id);
    this.onIssue(issue);
  }

  t = (key: TranslationKey, parameters: TranslationParameters = {}, locale = this.locale): string => {
    const local = this.messages.get(locale)?.get(key);
    const message = local ?? this.messages.get(this.fallbackLocale)?.get(key);
    if (message === undefined) {
      this.report({ kind: 'missing-key', key, locale });
      return `⟦${key}⟧`;
    }
    let template: string;
    if (typeof message === 'string') template = message;
    else {
      const count = parameters.count;
      if (typeof count !== 'number' || !Number.isFinite(count)) {
        this.report({ kind: 'invalid-count', key, locale });
        return `⟦${key}:count⟧`;
      }
      // A fallback English message must use English plural rules, even in another locale.
      const rule = new Intl.PluralRules(local === undefined ? this.fallbackLocale : locale).select(count);
      template = (message[rule] ?? message.other) as string;
    }
    return template.replace(parameterPattern, (token: string, parameter: string) => {
      const value = parameters[parameter];
      if (value === undefined || value === null) {
        this.report({ kind: 'missing-parameter', key, locale, parameter });
        return token;
      }
      return typeof value === 'number' ? this.formatNumber(value, {}, locale) : String(value);
    });
  };

  formatNumber = (value: number, options: Intl.NumberFormatOptions = {}, locale = this.locale): string => new Intl.NumberFormat(locale, options).format(value);
  formatDate = (value: Date | number | string, options: Intl.DateTimeFormatOptions = {}, locale = this.locale): string => {
    // Calendar-only values retain their calendar day regardless of the viewer's time zone.
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`));
    }
    return new Intl.DateTimeFormat(locale, options).format(typeof value === 'string' ? new Date(value) : value);
  };
}
