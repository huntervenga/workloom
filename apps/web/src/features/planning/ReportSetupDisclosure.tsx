import { Button } from '@workloom/ui';
import { useId, type ReactNode } from 'react';
import { useTranslation } from '../../i18n';
import type { ReportSetupState } from './reportSetupState';

interface Props {
  title: string;
  selector: ReactNode;
  hasSavedReport: boolean;
  setup: ReportSetupState | undefined;
  held: boolean;
  failed: boolean;
  onExpandedChange: (expanded: boolean) => void;
  children: ReactNode;
}

/** Setup is secondary to a selected result; unsaved or unresolved configuration stays visible. */
export function ReportSetupDisclosure({ title, selector, hasSavedReport, setup, held, failed, onExpandedChange, children }: Props) {
  const { t } = useTranslation();
  const id = useId();
  const guarded = !!setup?.dirty || held || failed;
  const open = !hasSavedReport || !!setup?.expanded || guarded;
  return <div className="space-y-3 rounded-xl border border-line bg-surface p-3 sm:p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-lg font-semibold">{title}</h2>
      {hasSavedReport ? <Button size="sm" variant="ghost" aria-controls={id} aria-expanded={open} disabled={open && guarded} onClick={() => onExpandedChange(!open)}>{open ? t('planning.reportSetup.hide') : t('planning.reportSetup.show')}</Button> : null}
    </div>
    {selector}
    <div id={id} hidden={!open} role="region" aria-label={t('planning.reportSetup.title')} className="space-y-3 border-t border-line pt-3">
      <h3 className="text-sm font-semibold">{t('planning.reportSetup.title')}</h3>
      {setup?.dirty ? <p role="status" className="text-xs text-muted">{t('planning.reportSetup.dirty')}</p> : null}
      {held ? <p role="status" className="text-xs text-muted">{t('planning.reportSetup.unconfirmed')}</p> : null}
      {children}
    </div>
  </div>;
}
