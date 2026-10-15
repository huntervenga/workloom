import { describe, expect, it } from 'vitest';
import { MAX_ESTIMATE_MINUTES, formatEstimate, formatEstimateInput, parseEstimateInput } from './estimate';

function minutesOf(raw: string): number | null {
  const result = parseEstimateInput(raw);
  if (!result.valid) throw new Error(`Expected "${raw}" to parse, got: ${result.message}`);
  return result.minutes;
}

function rejects(raw: string): string {
  const result = parseEstimateInput(raw);
  if (result.valid) throw new Error(`Expected "${raw}" to be rejected, got ${String(result.minutes)}`);
  return result.message;
}

describe('parseEstimateInput', () => {
  it('keeps "not estimated" and "estimated as zero" apart', () => {
    expect(minutesOf('')).toBeNull();
    expect(minutesOf('   ')).toBeNull();
    expect(minutesOf('0')).toBe(0);
    expect(minutesOf('0:00')).toBe(0);
    expect(minutesOf('0,0')).toBe(0);
  });

  it('reads decimal hours with a comma or a dot', () => {
    expect(minutesOf('1,5')).toBe(90);
    expect(minutesOf('1.5')).toBe(90);
    expect(minutesOf(' 2 ')).toBe(120);
    expect(minutesOf('0,25')).toBe(15);
  });

  it('computes on the typed digits, where float math would drift', () => {
    // 0.35 * 60 and 1.15 * 60 are not whole numbers in binary floating point.
    expect(minutesOf('0,35')).toBe(21);
    expect(minutesOf('1.15')).toBe(69);
    expect(minutesOf('0.1')).toBe(6);
  });

  it('rejects fractions of a minute instead of rounding them', () => {
    expect(rejects('0,01')).toMatch(/целых минутах/);
    expect(rejects('1.333')).toMatch(/целых минутах/);
  });

  it('reads H:MM with two-digit minutes from 00 to 59', () => {
    expect(minutesOf('1:30')).toBe(90);
    expect(minutesOf('0:05')).toBe(5);
    expect(minutesOf('10:59')).toBe(659);
    expect(rejects('1:60')).toMatch(/от 00 до 59/);
    rejects('1:5');
    rejects('1:300');
    rejects(':30');
  });

  it('rejects negatives and unrelated text', () => {
    expect(rejects('-1')).toMatch(/отрицательн/);
    expect(rejects('-0:30')).toMatch(/отрицательн/);
    rejects('1,5ч');
    rejects('1e3');
    rejects('1,');
    rejects('полтора');
  });

  it('accepts the int32 ceiling and rejects one minute more', () => {
    expect(minutesOf('35791394:07')).toBe(MAX_ESTIMATE_MINUTES);
    expect(rejects('35791394:08')).toMatch(/Слишком большая/);
    expect(rejects('35791395')).toMatch(/Слишком большая/);
    expect(rejects('99999999999999999999999')).toMatch(/Слишком большая/);
  });
});

describe('estimate formatting', () => {
  it('round-trips exact minutes through the edit field', () => {
    for (const minutes of [0, 1, 45, 90, 125, MAX_ESTIMATE_MINUTES]) {
      expect(minutesOf(formatEstimateInput(minutes))).toBe(minutes);
    }
    expect(formatEstimateInput(null)).toBe('');
    expect(formatEstimateInput(90)).toBe('1:30');
  });

  it('shows hours and minutes without rounding', () => {
    expect(formatEstimate(0)).toBe('0 мин');
    expect(formatEstimate(45)).toBe('45 мин');
    expect(formatEstimate(120)).toBe('2 ч');
    expect(formatEstimate(61)).toBe('1 ч 1 мин');
  });
});
