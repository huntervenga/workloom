import type { GenericReportNumberDto, PlanningCheckRuleDto } from '@workloom/contracts';
import { DomainError } from '../errors.js';

type Rational = { n: bigint; d: bigint };
type PlanningBand = Extract<PlanningCheckRuleDto, { kind: 'balance' }>['under'];
export type PlanningBalanceBand = {
  ratio: GenericReportNumberDto | null; direction: 'under' | 'within' | 'over' | null;
  appearance: { color: string; intensityBps: number } | null; reason: 'zero_target' | null;
};
const FULL_BPS = 10_000n;
const COLOR = /^#[0-9a-fA-F]{6}$/;
// Exact ECMAScript trim whitespace, matching the SQL presence projection.
const BLANK = /^\s*$/u;
function invalid(message: string): never { throw new DomainError('DOMAIN_VALIDATION_FAILED', message); }
// Rational arithmetic and the 12-place presentation mirror generic-reports/engine.ts exactly.
function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) [a, b] = [b, a % b];
  return a || 1n;
}
function rational(n: bigint, d = 1n): Rational {
  if (d === 0n) invalid('A planning number has an invalid denominator.');
  const divisor = gcd(n, d), sign = d < 0n ? -1n : 1n;
  return { n: sign * n / divisor, d: sign * d / divisor };
}
function decimal(value: number): Rational {
  if (!Number.isFinite(value)) invalid('A planning value must be finite.');
  const [base = '0', exponent = '0'] = value.toString().toLowerCase().split('e');
  const [whole = '0', fraction = ''] = base.split('.');
  const power = Number(exponent) - fraction.length, numerator = BigInt(whole + fraction);
  return power >= 0 ? rational(numerator * 10n ** BigInt(power)) : rational(numerator, 10n ** BigInt(-power));
}
const add = (a: Rational, b: Rational) => rational(a.n * b.d + b.n * a.d, a.d * b.d);
function output(value: Rational): GenericReportNumberDto {
  const normalized = rational(value.n, value.d), absolute = normalized.n < 0n ? -normalized.n : normalized.n;
  const scale = 1_000_000_000_000n;
  // Half away from zero at 12 decimal places; the rational remains authoritative.
  const rounded = (absolute * scale * 2n + normalized.d) / (2n * normalized.d);
  const digits = rounded.toString().padStart(13, '0'), fraction = digits.slice(-12).replace(/0+$/, '');
  return {
    numerator: normalized.n.toString(), denominator: normalized.d.toString(),
    decimal: (rounded === 0n || normalized.n >= 0n ? '' : '-') + digits.slice(0, -12) + (fraction ? `.${fraction}` : ''),
  };
}
function parse(value: GenericReportNumberDto): Rational {
  if (!/^-?\d+$/.test(value.numerator) || !/^[1-9]\d*$/.test(value.denominator)) invalid('A planning number is malformed.');
  return rational(BigInt(value.numerator), BigInt(value.denominator));
}
/** Sign of (value - bps / 10000), compared on integers only. */
function compareBps(value: Rational, bps: number): -1 | 0 | 1 {
  const left = value.n * FULL_BPS, right = BigInt(bps) * value.d;
  return left < right ? -1 : left > right ? 1 : 0;
}
/** 0 at the threshold, 10000 at full intensity, linear between, clamped, then rounded half up. */
function intensity(value: Rational, band: PlanningBand): number {
  const threshold = BigInt(band.thresholdBps);
  let numerator = (value.n * FULL_BPS - threshold * value.d) * FULL_BPS, denominator = (BigInt(band.fullIntensityAtBps) - threshold) * value.d;
  if (denominator === 0n) return 10_000;
  if (denominator < 0n) [numerator, denominator] = [-numerator, -denominator];
  if (numerator <= 0n) return 0;
  if (numerator >= denominator * FULL_BPS) return 10_000;
  // Only a value already clamped below 10000 is converted to a JS number.
  return Number((numerator * 2n + denominator) / (denominator * 2n));
}
export function exactPlanningNumber(value: number): GenericReportNumberDto { return output(decimal(value)); }
export function exactPlanningSum(values: readonly number[]): GenericReportNumberDto {
  return output(values.reduce((total, value) => add(total, decimal(value)), rational(0n)));
}
/** false and 0 are answers; null, undefined, [] and whitespace-only text are not. */
export function planningValuePresent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  return typeof value !== 'string' || !BLANK.test(value);
}
export function planningGradient(nearColor: string, farColor: string, intensityBps: number): string {
  if (!COLOR.test(nearColor) || !COLOR.test(farColor)) invalid('A planning color must be #RRGGBB.');
  if (!Number.isFinite(intensityBps)) invalid('A planning intensity must be finite.');
  const far = Math.min(10_000, Math.max(0, Math.round(intensityBps))), near = 10_000 - far;
  let color = '#';
  for (let offset = 1; offset < 7; offset += 2) {
    const from = parseInt(nearColor.slice(offset, offset + 2), 16), to = parseInt(farColor.slice(offset, offset + 2), 16);
    // Integer weights round the exact weighted mean half up, so swapping endpoints and intensity is symmetric.
    color += Math.floor((from * near + to * far + 5_000) / 10_000).toString(16).padStart(2, '0');
  }
  return color;
}
export function planningBalanceBand(planned: GenericReportNumberDto, target: GenericReportNumberDto, under: PlanningBand, over: PlanningBand): PlanningBalanceBand {
  const plan = parse(planned), total = parse(target);
  if (total.n === 0n) return { ratio: null, direction: null, appearance: null, reason: 'zero_target' };
  if (total.n < 0n) invalid('A planning target must not be negative.');
  const ratio = rational(plan.n * total.d, plan.d * total.n);
  const active = under.enabled && compareBps(ratio, under.thresholdBps) < 0 ? { direction: 'under' as const, band: under }
    : over.enabled && compareBps(ratio, over.thresholdBps) > 0 ? { direction: 'over' as const, band: over } : null;
  if (!active) return { ratio: output(ratio), direction: 'within', appearance: null, reason: null };
  const intensityBps = intensity(ratio, active.band);
  return {
    ratio: output(ratio), direction: active.direction, reason: null,
    appearance: { color: planningGradient(active.band.nearColor, active.band.farColor, intensityBps), intensityBps },
  };
}
