import { Button } from '@workloom/ui';
import { useId, type ReactNode } from 'react';
import { useTranslation } from '../../i18n';
import type { ReportSetupState } from './reportSetupState';

interface Props {
  title: string;
  selector: ReactNode;
  hasSavedReport: boolean;
  /** A safe explicit default calculation is available without opening advanced scope controls. */
  quickActionAvailable?: boolean;
  setup: ReportSetupState | undefined;
  held: boolean;
  failed: boolean;
  onExpandedChange: (expanded: boolean) => void;
  children: ReactNode;
}

/** Setup is secondary to a selected result; unsaved or unresolved configuration stays visible. */
export function ReportSetupDisclosure({ title, selector, hasSavedReport, quickActionAvailable = false, setup, held, failed, onExpandedChange, children }: Props) {
  const { t } = useTranslation();
  const id = useId();
  const guarded = !!setup?.dirty || held || failed;
  const open = (!hasSavedReport && !quickActionAvailable) || !!setup?.expanded || guarded;
  // One compact toolbar: title, saved-result choice and actions, then the secondary setup toggle.
  return <div className="space-y-3 rounded-xl border border-line bg-surface p-3">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <h2 className="mr-auto text-base font-semibold">{title}</h2>
      {selector}
      {hasSavedReport || quickActionAvailable ? <Button size="sm" variant="secondary" aria-controls={id} aria-expanded={open} disabled={open && guarded} onClick={() => onExpandedChange(!open)}>{open ? t('planning.reportSetup.hide') : t('planning.reportSetup.show')}</Button> : null}
    </div>
    <div id={id} hidden={!open} role="region" aria-label={t('planning.reportSetup.title')} className="space-y-3 border-t border-line pt-3">
      <h3 className="text-sm font-semibold">{t('planning.reportSetup.title')}</h3>
      {setup?.dirty ? <p role="status" className="text-xs text-muted">{t('planning.reportSetup.dirty')}</p> : null}
      {held ? <p role="status" className="text-xs text-muted">{t('planning.reportSetup.unconfirmed')}</p> : null}
      {children}
    </div>
  </div>;
}
