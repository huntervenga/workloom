/**
 * «Оценка задачи» input and display. Values are whole minutes of the shared work package budget;
 * `null` (not estimated) and `0` (estimated as zero) stay different all the way through.
 */

/** Same ceiling as `minutesSchema` in `@workloom/contracts`. */
export const MAX_ESTIMATE_MINUTES = 2_147_483_647;

const MAX_ESTIMATE_MINUTES_BIG = BigInt(MAX_ESTIMATE_MINUTES);
const MAX_INPUT_LENGTH = 64;

/** Decimal hours with a dot or a comma: `2`, `1.5`, `1,25`. */
const DECIMAL_HOURS = /^(\d+)(?:[.,](\d+))?$/;
/** Hours and two-digit minutes: `1:30`, `0:05`. */
const HOURS_MINUTES = /^(\d+):(\d{2})$/;
const NEGATIVE = /^[-−–]/;

export type EstimateInputResult =
  | { valid: true; minutes: number | null }
  | { valid: false; message: string };

function invalid(message: string): EstimateInputResult {
  return { valid: false, message };
}

function fromMinutes(minutes: bigint): EstimateInputResult {
  if (minutes > MAX_ESTIMATE_MINUTES_BIG) return invalid('Слишком большая оценка.');
  return { valid: true, minutes: Number(minutes) };
}

/**
 * Parses what a person types into the estimate field. Empty means «not estimated» (`null`).
 * Accepts decimal hours (`1.5`, `1,5` → 90) and `Ч:ММ` (`1:30` → 90). Arithmetic runs on the
 * typed digits, so `0,35` is exactly 21 minutes; values that are not whole minutes are rejected
 * rather than rounded.
 */
export function parseEstimateInput(raw: string): EstimateInputResult {
  const value = raw.trim();
  if (value === '') return { valid: true, minutes: null };
  if (value.length > MAX_INPUT_LENGTH) return invalid('Слишком длинное значение.');
  if (NEGATIVE.test(value)) return invalid('Оценка не может быть отрицательной.');

  const clock = HOURS_MINUTES.exec(value);
  if (clock) {
    const [, hours = '0', minutes = '0'] = clock;
    const minutePart = BigInt(minutes);
    if (minutePart > 59n) return invalid('В формате Ч:ММ минут должно быть от 00 до 59.');
    return fromMinutes(BigInt(hours) * 60n + minutePart);
  }

  const decimal = DECIMAL_HOURS.exec(value);
  if (decimal) {
    const [, whole = '0', fraction = ''] = decimal;
    const scale = 10n ** BigInt(fraction.length);
    const scaledMinutes = (BigInt(whole) * scale + BigInt(fraction === '' ? '0' : fraction)) * 60n;
    if (scaledMinutes % scale !== 0n) {
      return invalid('Оценка должна быть в целых минутах, например 1,5 или 1:20.');
    }
    return fromMinutes(scaledMinutes / scale);
  }

  return invalid('Введите часы, например 1,5 или 1:30.');
}

function assertMinutes(minutes: number): void {
  if (!Number.isSafeInteger(minutes) || minutes < 0) {
    throw new RangeError(`Expected whole non-negative minutes, got ${minutes}.`);
  }
}

/** Exact `Ч:ММ` text for the edit field; parses back to the same minutes. `null` → empty. */
export function formatEstimateInput(minutes: number | null): string {
  if (minutes === null) return '';
  assertMinutes(minutes);
  const hours = Math.floor(minutes / 60);
  return `${hours}:${String(minutes % 60).padStart(2, '0')}`;
}

const hoursFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });

/** Readable value such as «1 ч 30 мин», «45 мин» or «0 мин». Never rounds. */
export function formatEstimate(minutes: number): string {
  assertMinutes(minutes);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} мин`;
  const hoursText = `${hoursFormat.format(hours)} ч`;
  return rest === 0 ? hoursText : `${hoursText} ${rest} мин`;
}
