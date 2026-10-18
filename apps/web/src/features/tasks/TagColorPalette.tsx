import { useId, type KeyboardEvent } from 'react';
import { useTranslation } from '../../i18n';
import { TAG_COLORS } from './tagColors';

export interface TagColorPaletteProps {
  value: string | null; disabled?: boolean | undefined;
  onChange: (color: string | null) => void;
}
/** Native radios supply Tab/arrow/Space behavior; Enter never submits an enclosing task form. */
export function TagColorPalette({ value, disabled = false, onChange }: TagColorPaletteProps) {
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
    <legend className="text-xs font-medium text-ink">{t('tagColors.palette')}</legend>
    <div className="flex flex-wrap gap-2">{TAG_COLORS.map(({ name, color }) => <label key={color} className="inline-flex cursor-pointer items-center gap-1.5 rounded border border-line bg-surface px-2 py-1 text-xs text-ink has-focus-visible:outline-2 has-focus-visible:outline-accent-ink">
      <input type="radio" name={id} value={color} checked={value?.toLowerCase() === color} onChange={() => onChange(color)} className="accent-accent" />
      <span aria-hidden="true" className="size-3 rounded-full" style={{ backgroundColor: color }} />{labels[name]}
    </label>)}</div>
  </fieldset>;
}
