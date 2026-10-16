import type { TranslationKey, TranslationParameters } from './LocalizationManager';

/** Keep message identity in visible state; translate during render with the current locale. */
export interface TranslationMessage {
  readonly key: TranslationKey;
  readonly params?: TranslationParameters;
}

export function message(key: TranslationKey, params?: TranslationParameters): TranslationMessage {
  return params === undefined ? { key } : { key, params };
}
