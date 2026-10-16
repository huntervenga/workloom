import { Languages } from 'lucide-react';
import { useId } from 'react';
import { useTranslation } from '../../i18n';

/** Available choices come directly from discovered JSON locale directories. */
export function LanguageSelector() {
  const { t, locale, setLocale, availableLocales } = useTranslation();
  const id = useId();
  if (availableLocales.length < 2) return null;
  const names = new Intl.DisplayNames([locale], { type: 'language' });
  return (
    <div className="relative flex items-center gap-1 text-muted">
      <Languages size={16} aria-hidden="true" className="pointer-events-none absolute left-2" />
      <label htmlFor={id} className="sr-only">{t('common.language')}</label>
      <select id={id} value={locale} onChange={(event) => setLocale(event.target.value)} className="max-w-36 rounded-lg border border-line bg-surface py-1.5 pr-2 pl-7 text-xs text-ink focus:outline-2 focus:outline-accent">
        {availableLocales.map((value) => <option key={value} value={value}>{names.of(value) ?? value}</option>)}
      </select>
    </div>
  );
}
