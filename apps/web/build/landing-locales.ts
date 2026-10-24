import english from '../src/i18n/locales/en/landing.json';
import ru from '../src/landing/locales/ru.json';
import ja from '../src/landing/locales/ja.json';
import ko from '../src/landing/locales/ko.json';
import es from '../src/landing/locales/es.json';
import pt from '../src/landing/locales/pt-br.json';

// Landing-only catalogs must not expose partially translated locales in the workspace app.
export const landingCatalogs = { en: english, ru, ja, ko, es, 'pt-br': pt } satisfies Record<string, typeof english>;
export type LandingLocale = keyof typeof landingCatalogs;
export const landingLocales = Object.keys(landingCatalogs) as LandingLocale[];
export const languageDescriptors = {
  en: { label: 'English', flag: '🇬🇧', lang: 'en', og: 'en_US' },
  ru: { label: 'Русский', flag: '🇷🇺', lang: 'ru', og: 'ru_RU' },
  ja: { label: '日本語', flag: '🇯🇵', lang: 'ja', og: 'ja_JP' },
  ko: { label: '한국어', flag: '🇰🇷', lang: 'ko', og: 'ko_KR' },
  es: { label: 'Español', flag: '🌎', lang: 'es-419', og: 'es_419' },
  'pt-br': { label: 'Português (Brasil)', flag: '🇧🇷', lang: 'pt-BR', og: 'pt_BR' },
} as const;
export function landingPath(locale: LandingLocale, start = false): string {
  return `${start ? '/start' : ''}${locale === 'en' ? (start ? '' : '/') : `/${locale}`}`;
}
export function localeFromUrl(url: string): LandingLocale {
  const parsed = new URL(url, 'http://localhost');
  const candidate = parsed.searchParams.get('__wl_locale') ?? parsed.pathname.replace(/^\/start\//, '').replace(/^\//, '').replace(/\/$/, '');
  return landingLocales.find(locale => locale === candidate) ?? 'en';
}
