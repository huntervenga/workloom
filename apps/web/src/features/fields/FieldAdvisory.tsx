import type { CSSProperties } from 'react';
import { CircleAlert, Info, TriangleAlert } from 'lucide-react';
import { useTranslation } from '../../i18n';

/** A server-known issue only; parents pass null while assessment is unavailable or out of scope. */
export interface FieldAdvisory {
  state: 'missing' | 'unavailable';
  label: string;
  severity: 'notice' | 'warning' | 'critical';
  color?: string;
}

/** Custom colors tint the background only. Text and the issue icon keep theme contrast. */
export function fieldAdvisoryStyle(advisory?: FieldAdvisory | null): CSSProperties | undefined {
  if (advisory?.state !== 'missing') return undefined;
  const color = advisory.color && /^#[0-9a-fA-F]{6}$/.test(advisory.color) ? advisory.color : '#d97706';
  return { backgroundColor: `${color}18` };
}

export function FieldAdvisoryIndicator({ advisory }: { advisory?: FieldAdvisory | null }) {
  const { t } = useTranslation();
  if (advisory?.state !== 'missing') return null;
  const severity = advisory.severity === 'critical' ? t('fields.advisory.critical') : advisory.severity === 'warning' ? t('fields.advisory.warning') : t('fields.advisory.notice');
  const label = t('fields.advisory.label', { severity, message: advisory.label });
  const Icon = advisory.severity === 'critical' ? TriangleAlert : advisory.severity === 'warning' ? CircleAlert : Info;
  return <span role="img" aria-label={label} title={label} data-field-advisory={advisory.severity} className="inline-flex size-5 shrink-0 items-center justify-center rounded bg-surface text-ink">
    <Icon size={13} aria-hidden="true" />
  </span>;
}
