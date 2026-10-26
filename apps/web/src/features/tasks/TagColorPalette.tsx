import { Check } from 'lucide-react';
import { useId, type KeyboardEvent } from 'react';
import { useTranslation } from '../../i18n';
import { TAG_COLORS } from './tagColors';

export interface TagColorPaletteProps {
  value: string | null; disabled?: boolean | undefined;
  onChange: (color: string | null) => void;
  compact?: boolean | undefined;
}
/** Native radios supply Tab/arrow/Space behavior; Enter never submits an enclosing task form. */
export function TagColorPalette({ value, disabled = false, onChange, compact = false }: TagColorPaletteProps) {
  const { t } = useTranslation(), id = useId();
  const labels = {
    blue: t('tagColors.paletteNames.blue'),
    purple: t('tagColors.paletteNames.purple'),
    pink: t('tagColors.paletteNames.pink'),
    red: t('tagColors.paletteNames.red'),
    orange: t('tagColors.paletteNames.orange'),
    yellow: t('tagColors.paletteNames.yellow'),
    green: t('tagColors.paletteNames.green'),
    teal: t('tagColors.paletteNames.teal'),
  };
  const keyDown = (event: KeyboardEvent) => { if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); } };
  return <fieldset disabled={disabled} onKeyDown={keyDown} className="min-w-0 space-y-2">
    <legend className={compact ? 'sr-only' : 'text-xs font-medium text-ink'}>{t('tagColors.palette')}</legend>
    <div className={compact ? 'grid grid-cols-4 gap-2' : 'flex flex-wrap gap-2'}>{TAG_COLORS.map(({ name, color }) => <label key={color}
      title={compact ? labels[name] : undefined}
      className={compact ? 'relative flex size-8 cursor-pointer items-center justify-center rounded-md has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-accent-ink' : 'inline-flex cursor-pointer items-center gap-1.5 rounded border border-line bg-surface px-2 py-1 text-xs text-ink has-focus-visible:outline-2 has-focus-visible:outline-accent-ink'}>
      <input type="radio" name={id} value={color} checked={value?.toLowerCase() === color} onChange={() => onChange(color)} className={compact ? 'sr-only' : 'accent-accent'} />
      <span aria-hidden="true" className={compact ? 'absolute inset-0 rounded-md border border-black/10' : 'size-3 rounded-full'} style={{ backgroundColor: color }} />
      {compact && value?.toLowerCase() === color ? <Check size={18} aria-hidden="true" className="pointer-events-none relative text-white drop-shadow-sm" /> : null}
      <span className={compact ? 'sr-only' : undefined}>{labels[name]}</span>
    </label>)}</div>
  </fieldset>;
}
