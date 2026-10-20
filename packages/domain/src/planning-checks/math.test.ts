import type { PlanningCheckRuleDto } from '@workloom/contracts';
import { describe, expect, it } from 'vitest';
import { DomainError } from '../errors.js';
import { exactPlanningNumber as n, exactPlanningSum, planningBalanceBand, planningGradient, planningValuePresent } from './math.js';

type Band = Extract<PlanningCheckRuleDto, { kind: 'balance' }>['under'];
const band = (thresholdBps: number, fullIntensityAtBps: number, nearColor = '#FFAA00', farColor = '#aa0000'): Band => ({ enabled: true, thresholdBps, fullIntensityAtBps, nearColor, farColor });
const off = (value: Band): Band => ({ ...value, enabled: false });
const under = band(6000, 4500, '#FFE08A', '#3366FF'), over = band(12000, 15000), hundred = n(100);
const huge = `1${'0'.repeat(600)}`;

describe('exact planning numbers', () => {
  it('sums decimal inputs exactly instead of in binary floating point', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(exactPlanningSum([0.1, 0.2])).toEqual({ numerator: '3', denominator: '10', decimal: '0.3' });
    expect(exactPlanningSum([])).toEqual({ numerator: '0', denominator: '1', decimal: '0' });
    expect(exactPlanningSum([-1.25, 0.25, -0])).toEqual({ numerator: '-1', denominator: '1', decimal: '-1' });
  });
  it('keeps negative, tiny and exponent values exact with half-away 12-place decimals', () => {
    expect(n(-2.5e-7)).toEqual({ numerator: '-1', denominator: '4000000', decimal: '-0.00000025' });
    expect(n(1.5e21)).toEqual({ numerator: '1500000000000000000000', denominator: '1', decimal: '1500000000000000000000' });
    expect(n(5e-324)).toEqual({ numerator: '1', denominator: `2${'0'.repeat(323)}`, decimal: '0' });
    expect(n(-5e-13).decimal).toBe('-0.000000000001');
    expect(n(-4e-13).decimal).toBe('0');
  });
  it('rejects non-finite values', () => {
    expect(() => n(Number.POSITIVE_INFINITY)).toThrow(DomainError);
    expect(() => exactPlanningSum([1, Number.NaN])).toThrow(DomainError);
  });
});

describe('planningValuePresent', () => {
  it('treats false, zero, objects and real text as present', () => {
    // U+200B is a format character, not whitespace, so it counts as content.
    for (const value of [false, 0, -0, {}, [0], 'x', ' a ', '\u200b', '\u0085']) expect(planningValuePresent(value), JSON.stringify(value)).toBe(true);
  });
  it('treats nullish, empty arrays and Unicode-whitespace-only text as missing', () => {
    for (const value of [null, undefined, [], '', ' \t\r\n', '\u00a0\u2003\u3000', '\u2028\u2029', '\ufeff']) expect(planningValuePresent(value), JSON.stringify(value)).toBe(false);
  });
});

describe('planningGradient', () => {
  it('returns lowercase endpoints and clamps intensity', () => {
    expect(planningGradient('#00AAFF', '#FF5500', 0)).toBe('#00aaff');
    expect(planningGradient('#00AAFF', '#FF5500', 10000)).toBe('#ff5500');
    expect(planningGradient('#00AAFF', '#FF5500', -250)).toBe('#00aaff');
    expect(planningGradient('#00AAFF', '#FF5500', 99999)).toBe('#ff5500');
  });
  it('rounds the midpoint half up, symmetrically in both directions', () => {
    expect(planningGradient('#000000', '#FFFFFF', 5000)).toBe('#808080');
    expect(planningGradient('#ffffff', '#000000', 5000)).toBe('#808080');
    expect(planningGradient('#FFAA00', '#aa0000', 5000)).toBe('#d55500');
  });
  it('rejects malformed colors', () => {
    expect(() => planningGradient('#fff', '#000000', 0)).toThrow(DomainError);
  });
});

describe('planningBalanceBand', () => {
  const cases: Array<[number, 'under' | 'within' | 'over', number | null]> = [
    [-10, 'under', 10000], [30, 'under', 10000], [45, 'under', 10000], [50, 'under', 6667], [52.5, 'under', 5000],
    [60, 'within', null], [100, 'within', null], [120, 'within', null],
    [125, 'over', 1667], [135, 'over', 5000], [150, 'over', 10000], [400, 'over', 10000],
  ];
  it.each(cases)('planned %d of 100 is %s at %o bps', (planned, direction, intensityBps) => {
    const result = planningBalanceBand(n(planned), hundred, under, over);
    expect(result.reason).toBeNull();
    expect(result.direction).toBe(direction);
    expect(result.appearance?.intensityBps ?? null).toBe(intensityBps);
  });
  it('reports the exact ratio and colors the active band', () => {
    expect(planningBalanceBand(n(135), hundred, under, over)).toEqual({ ratio: { numerator: '27', denominator: '20', decimal: '1.35' }, direction: 'over', appearance: { color: '#d55500', intensityBps: 5000 }, reason: null });
    expect(planningBalanceBand(n(30), hundred, under, over).appearance).toEqual({ color: '#3366ff', intensityBps: 10000 });
    expect(planningBalanceBand(n(1), n(3), under, over).ratio?.decimal).toBe('0.333333333333');
  });
  it('compares the exact rational rather than the floating-point sum', () => {
    expect(0.7 + 0.1).toBeLessThan(0.8);
    expect(planningBalanceBand(exactPlanningSum([0.7, 0.1]), n(1), band(8000, 5000), off(over))).toMatchObject({ direction: 'within', ratio: { numerator: '4', denominator: '5' } });
  });
  it('skips disabled sides and stays within when no band is enabled', () => {
    expect(planningBalanceBand(n(10), hundred, off(under), over).direction).toBe('within');
    expect(planningBalanceBand(n(500), hundred, under, off(over)).direction).toBe('within');
    expect(planningBalanceBand(n(500), hundred, off(under), off(over))).toEqual({ ratio: { numerator: '5', denominator: '1', decimal: '5' }, direction: 'within', appearance: null, reason: null });
  });
  it.each([0, 5, -5])('marks a zero target unavailable for planned %d', planned => {
    expect(planningBalanceBand(n(planned), exactPlanningSum([0, -0]), under, over)).toEqual({ ratio: null, direction: null, appearance: null, reason: 'zero_target' });
  });
  it('keeps huge and tiny ratios exact without floating overflow', () => {
    expect(Number(huge)).toBe(Number.POSITIVE_INFINITY);
    expect(planningBalanceBand(n(1e300), n(1e-300), under, over)).toEqual({ ratio: { numerator: huge, denominator: '1', decimal: huge }, direction: 'over', appearance: { color: '#aa0000', intensityBps: 10000 }, reason: null });
    expect(planningBalanceBand(n(1e-300), n(1e300), under, over)).toMatchObject({ direction: 'under', ratio: { numerator: '1', denominator: huge, decimal: '0' }, appearance: { intensityBps: 10000 } });
  });
});
