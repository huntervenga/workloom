import type { LeaveOverviewDto, LeaveSettingsDto, LeaveWarningsDto, LeaveWarningCode } from '@workloom/contracts';
import { useTranslation } from '../../i18n';

/** Server-authored diagnostics: these explain the result and never grant permission. */
export function LeaveWarnings({ warnings, settings, members = [], membershipId }: { warnings?: LeaveWarningsDto | undefined; settings?: LeaveSettingsDto | null | undefined; members?: LeaveOverviewDto['members']; membershipId?: string | undefined }) {
  const { t, locale } = useTranslation();
  if (!warnings || warnings.totalCount === 0) return null;
  const visibleWarnings = membershipId === undefined ? warnings.warnings : warnings.warnings.filter(warning => warning.membershipId === membershipId);
  if (visibleWarnings.length === 0 && !warnings.truncated) return null;
  const labels: Record<LeaveWarningCode, string> = {
    ACCOUNTING_BEFORE_EMPLOYMENT: t('timeOff.warningACCOUNTING_BEFORE_EMPLOYMENT'),
    OUTSIDE_EMPLOYMENT: t('timeOff.warningOUTSIDE_EMPLOYMENT'),
    BEFORE_ACCOUNTING: t('timeOff.warningBEFORE_ACCOUNTING'),
    MISSING_POLICY: t('timeOff.warningMISSING_POLICY'),
    MISSING_TYPE: t('timeOff.warningMISSING_TYPE'),
    ARCHIVED_TYPE: t('timeOff.warningARCHIVED_TYPE'),
    TYPE_BEHAVIOR_CHANGED: t('timeOff.warningTYPE_BEHAVIOR_CHANGED'),
    OVERLAP: t('timeOff.warningOVERLAP'),
    NEGATIVE_BALANCE: t('timeOff.warningNEGATIVE_BALANCE'),
    PAID_POOL_DEBT: t('timeOff.warningPAID_POOL_DEBT'),
    NEGATIVE_OPENING: t('timeOff.warningNEGATIVE_OPENING'),
    ADJUSTMENT_BEFORE_ACCOUNTING: t('timeOff.warningADJUSTMENT_BEFORE_ACCOUNTING'),
  };
  return <section aria-label={t('timeOff.administrationWarnings')} className="space-y-2 rounded-lg border border-amber-500/30 bg-canvas p-3"><h3 className="text-sm font-semibold">{t('timeOff.administrationWarnings')}</h3><p role="status" className="text-xs text-ink-soft">{t('timeOff.administrationWarningHint')}</p><ul className="max-h-64 space-y-2 overflow-auto text-xs">{visibleWarnings.map((warning, index) => {
    const person = members.find(member => member.id === warning.membershipId)?.displayName;
    const type = settings?.policyVersions.flatMap(version => version.types).find(item => item.id === warning.typeId)?.name;
    return <li key={`${warning.code}:${warning.entityId}:${warning.startDate}:${index}`} className="space-y-0.5"><p className="font-medium">{labels[warning.code]}</p>{person || type || warning.startDate || warning.availableMicrodays !== null ? <p className="text-muted">{[person, type, warning.startDate ? `${warning.startDate}${warning.endDate && warning.endDate !== warning.startDate ? ` → ${warning.endDate}` : ''}` : null, warning.availableMicrodays !== null ? t('timeOff.dayCount', { days: new Intl.NumberFormat(locale, { maximumFractionDigits: 6 }).format(warning.availableMicrodays / 1_000_000) }) : null].filter(Boolean).join(' · ')}</p> : null}</li>;
  })}</ul>{warnings.truncated ? <p className="text-xs text-muted">{membershipId === undefined ? t('timeOff.warningsTruncated', { shown: visibleWarnings.length, count: warnings.totalCount }) : t('timeOff.scopedWarningsTruncated')}</p> : null}</section>;
}
