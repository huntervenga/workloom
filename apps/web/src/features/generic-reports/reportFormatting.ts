import type { GenericReportNumberDto } from '@workloom/contracts';
import { t } from '../../i18n';
/** Half-up display rounding uses the authoritative rational, including values beyond Number precision. */
export function roundedRational(numerator: bigint, denominator: bigint): { text: string; width: string } {
  const magnitude = numerator < 0n ? -numerator : numerator;
  const scaled = magnitude * 100n, remainder = scaled % denominator;
  const hundredths = scaled / denominator + (remainder * 2n >= denominator ? 1n : 0n);
  const fraction = (hundredths % 100n).toString().padStart(2, '0').replace(/0+$/, '');
  const width = `${hundredths / 100n}${fraction ? `.${fraction}` : ''}`;
  return { text: `${remainder !== 0n ? '≈' : ''}${numerator < 0n && hundredths !== 0n ? '-' : ''}${width}`, width };
}
export function exactTitle(value: GenericReportNumberDto | null): string | undefined {
  return value ? `${value.numerator}/${value.denominator} (${value.decimal})` : undefined;
}
/** Never rebuild an authoritative aggregate from loaded detail rows or convert its exact decimal to float. */
export function reportNumber(value: GenericReportNumberDto | null, unit: string, compact = false): string {
  if (value === null) return '—';
  if (unit === 'minutes' && value.denominator === '1') {
    const signed = BigInt(value.numerator), minutes = signed < 0n ? -signed : signed;
    const hours = minutes / 60n, rest = minutes % 60n;
    const shown = hours === 0n ? t('genericReports.durationMinutes', { minutes: rest.toString() }) : rest === 0n ? t('genericReports.durationHours', { hours: hours.toString() }) : t('genericReports.durationHoursMinutes', { hours: hours.toString(), minutes: rest.toString() });
    return signed < 0n ? `-${shown}` : shown;
  }
  const rounded = compact ? roundedRational(BigInt(value.numerator), BigInt(value.denominator)).text : value.decimal;
  return unit === 'minutes' ? `${rounded} ${t('genericReports.minutes')}` : rounded;
}
