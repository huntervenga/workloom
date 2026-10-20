import { Button } from '@workloom/ui';
import { ListChecks } from 'lucide-react';
import { useTranslation } from '../../i18n';

/** Shortcut to the one page-owned settings editor. This component never writes field values. */
export function FieldPlanningCheckSettings({ fieldId, fieldName, disabled = false, onConfigure }: {
  fieldId: string; fieldName: string; disabled?: boolean; onConfigure: (fieldId: string) => void;
}) {
  const { t } = useTranslation();
  return <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
    <p className="max-w-sm text-xs text-muted">{t('fields.planningCheckSettings.help')}</p>
    <Button type="button" size="sm" variant="ghost" disabled={disabled} aria-label={t('fields.planningCheckSettings.configureField', { field: fieldName })} onClick={() => onConfigure(fieldId)}>
      <ListChecks size={14} aria-hidden="true" />{t('fields.planningCheckSettings.configure')}
    </Button>
  </div>;
}
