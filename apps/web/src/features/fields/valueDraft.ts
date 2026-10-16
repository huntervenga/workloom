import { t, formatNumber, localization } from '../../i18n';
/**
 * Editable drafts for typed custom field values. A draft keeps what the person typed or picked;
 * `parseFieldDraft` turns it into a `TaskFieldData` through the shared contract schema. An
 * explicit clear (`null`) stays different from `''`, `0`, `false` and `[]` all the way through.
 */
import {
  taskFieldDataSchema,
  type MembershipDto,
  type TaskFieldData,
  type TaskFieldDefinitionDto,
  type TaskFieldOptionDto,
} from '@workloom/contracts';
// Direct module import: the table will render these fields, so avoid a cycle through its index.
import { formatEstimateInput, parseEstimateInput } from '../task-table/estimate';

/** Same copy as the task form uses for memberships no longer in the workspace. */
export const UNAVAILABLE_MEMBER = () => t('fields.valueDraft.memberUnavailable');
export const UNAVAILABLE_OPTION = () => t('fields.valueDraft.optionUnavailable');
export const NOT_SET = () => t('fields.valueDraft.notSet');
export const NOTHING_SELECTED = () => t('fields.valueDraft.nothingSelected');

export type FieldDraft =
  /** `null` is a cleared value; `''` is an empty text, kept as typed. */
  | { type: 'text'; value: string | null }
  /** Raw input; an empty field means a cleared value. */
  | { type: 'number' | 'duration' | 'date' | 'url'; text: string }
  | { type: 'single_select'; value: string | null }
  /** Selected IDs in pick order; `null` is a cleared value, `[]` an explicit empty choice. */
  | { type: 'multi_select' | 'person'; value: readonly string[] | null }
  | { type: 'boolean'; value: boolean | null };

export type FieldDraftResult = { ok: true; value: TaskFieldData } | { ok: false; message: string };

const DECIMAL_NUMBER = /^([-−–]?)(\d+)(?:[.,](\d+))?$/;

const messages = {
  get stale() { return t('fields.valueDraft.thisFieldChangedRefreshThePageAndEnter'); },
  get text() { return t('fields.valueDraft.textMustBe10000CharactersOrFewer'); },
  get number() { return t('fields.valueDraft.enterANumberSuchAs12Or3'); },
  get numberRange() { return t('fields.valueDraft.numberMustBeBetween1000000000'); },
  // The shared hours parser speaks about task estimates; custom durations get neutral copy.
  get duration() { return t('fields.valueDraft.enterHoursAs15Or130'); },
  get date() { return t('fields.valueDraft.enterAValidDate'); },
  get url() { return t('fields.valueDraft.enterAURLStartingWithHttpOrHttps'); },
  get reference() { return t('fields.valueDraft.selectionUnavailableRefreshThePageAndTryAgain'); },
  get boolean() { return t('fields.valueDraft.chooseYesNoOrNotSet'); },
} as const;

function fail(message: string): FieldDraftResult {
  return { ok: false, message };
}

export function sameId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Unique IDs, compared case-insensitively, first spelling kept. */
export function uniqueIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  return ids.filter((id) => {
    const key = id.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Whole non-negative minutes that the shared hours formatter accepts. */
export function isMinutes(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Plain decimal text without exponent, e.g. `1.5e-7` → `0.00000015`. */
function plainDecimal(value: number): string {
  const text = String(Object.is(value, -0) ? 0 : value);
  const scientific = /^(-?)(\d+)(?:\.(\d+))?e([+-]?\d+)$/i.exec(text);
  if (!scientific) return text;
  const [, sign = '', whole = '0', fraction = '', exponent = '0'] = scientific;
  const digits = whole + fraction;
  const point = whole.length + Number(exponent);
  if (point <= 0) return sign + '0.' + '0'.repeat(-point) + digits;
  if (point >= digits.length) return sign + digits + '0'.repeat(point - digits.length);
  return sign + digits.slice(0, point) + '.' + digits.slice(point);
}

const integerFormat = { format: (value: number) => formatNumber(value, { maximumFractionDigits: 0 }) };

/** Localized number text that preserves every stored decimal without rounding. */
export function formatFieldNumber(value: number): string {
  const [whole = '0', fraction] = plainDecimal(value).split('.');
  const negative = whole.startsWith('-');
  const grouped = integerFormat.format(Number(negative ? whole.slice(1) : whole));
  const formatter = new Intl.NumberFormat(localization.getLocale());
  const decimal = formatter.formatToParts(1.1).find(part => part.type === 'decimal')?.value ?? '.';
  // Format individual digits, never the fraction as a number: leading zeroes and every
  // expanded decimal must survive, including values smaller than Intl's precision limit.
  const localizedFraction = fraction?.replace(/[0-9]/g, digit => formatter.format(Number(digit)));
  return `${negative ? '−' : ''}${grouped}${localizedFraction ? `${decimal}${localizedFraction}` : ''}`;
}

function parseNumberText(text: string): { ok: true; value: number } | { ok: false; message: string } {
  const match = DECIMAL_NUMBER.exec(text);
  if (!match) return { ok: false, message: messages.number };
  const [, sign = '', whole = '0', fraction = ''] = match;
  const value = Number(`${sign === '' ? '' : '-'}${whole}.${fraction === '' ? '0' : fraction}`);
  if (!Number.isFinite(value)) return { ok: false, message: messages.number };
  return { ok: true, value: Object.is(value, -0) ? 0 : value };
}

/** The draft for a stored value; a missing value or one of another type starts cleared. */
export function draftFromFieldValue(field: TaskFieldDefinitionDto, value: TaskFieldData | null | undefined): FieldDraft {
  const data = value?.type === field.type ? value : null;
  switch (field.type) {
    case 'text':
      return { type: 'text', value: data?.type === 'text' ? data.value : null };
    case 'number':
      return { type: 'number', text: data?.type === 'number' && data.value !== null ? plainDecimal(data.value) : '' };
    case 'duration':
      return { type: 'duration', text: data?.type === 'duration' && isMinutes(data.value) ? formatEstimateInput(data.value) : '' };
    case 'date':
      return { type: 'date', text: data?.type === 'date' ? (data.value ?? '') : '' };
    case 'url':
      return { type: 'url', text: data?.type === 'url' ? (data.value ?? '') : '' };
    case 'single_select':
      return { type: 'single_select', value: data?.type === 'single_select' ? data.value : null };
    case 'multi_select':
      return { type: 'multi_select', value: data?.type === 'multi_select' ? data.value : null };
    case 'person':
      return { type: 'person', value: data?.type === 'person' ? data.value : null };
    case 'boolean':
      return { type: 'boolean', value: data?.type === 'boolean' ? data.value : null };
  }
}

/** A draft with the value cleared (`null`). */
export function clearedFieldDraft(field: TaskFieldDefinitionDto): FieldDraft {
  return draftFromFieldValue(field, null);
}

/** Whether the draft currently holds an explicit clear. */
export function isClearedDraft(draft: FieldDraft): boolean {
  switch (draft.type) {
    case 'number':
    case 'duration':
    case 'date':
    case 'url':
      return draft.text.trim() === '';
    default:
      return draft.value === null;
  }
}

/** Validates a draft with the shared value schema. Never rounds and never turns garbage into `0`. */
export function parseFieldDraft(field: TaskFieldDefinitionDto, draft: FieldDraft): FieldDraftResult {
  if (draft.type !== field.type) return fail(messages.stale);

  let value: unknown;
  let message: string;
  switch (draft.type) {
    case 'text':
      value = draft.value;
      message = messages.text;
      break;
    case 'number': {
      const text = draft.text.trim();
      if (text === '') {
        value = null;
      } else {
        const parsed = parseNumberText(text);
        if (!parsed.ok) return fail(parsed.message);
        value = parsed.value;
      }
      message = messages.numberRange;
      break;
    }
    case 'duration': {
      const parsed = parseEstimateInput(draft.text);
      if (!parsed.valid) return fail(messages.duration);
      value = parsed.minutes;
      message = messages.duration;
      break;
    }
    case 'date':
    case 'url': {
      const text = draft.text.trim();
      value = text === '' ? null : text;
      message = draft.type === 'date' ? messages.date : messages.url;
      break;
    }
    case 'single_select':
      value = draft.value;
      message = messages.reference;
      break;
    case 'multi_select':
    case 'person':
      value = draft.value === null ? null : uniqueIds(draft.value);
      message = messages.reference;
      break;
    case 'boolean':
      value = draft.value;
      message = messages.boolean;
      break;
  }

  const parsed = taskFieldDataSchema.safeParse({ type: field.type, value });
  return parsed.success ? { ok: true, value: parsed.data } : fail(message);
}

/** Only absolute http/https links pass, judged by the shared value schema. */
export function isSafeLink(value: string): boolean {
  return taskFieldDataSchema.safeParse({ type: 'url', value }).success;
}

export function optionsByPosition(options: readonly TaskFieldOptionDto[]): TaskFieldOptionDto[] {
  return [...options].sort((a, b) => a.position - b.position);
}

/** IDs a stored value references; empty for a cleared value or another type. */
export function referencedIds(field: TaskFieldDefinitionDto, value: TaskFieldData | null | undefined): string[] {
  if (!value || value.type !== field.type || value.value === null) return [];
  if (value.type === 'single_select') return [value.value];
  if (value.type === 'multi_select' || value.type === 'person') return [...value.value];
  return [];
}

export type ReferenceState = 'active' | 'archived' | 'unavailable';

export interface ReferenceLabel {
  id: string;
  label: string;
  state: ReferenceState;
  color: string | null;
}

/** Labels for referenced IDs in the given order; unknown ones get neutral, numbered copy. */
export function referenceLabels(
  field: TaskFieldDefinitionDto,
  ids: readonly string[],
  members: readonly MembershipDto[],
): ReferenceLabel[] {
  const unknownIds = ids.filter((id) =>
    field.type === 'person'
      ? !members.some((member) => sameId(member.id, id))
      : !field.options.some((option) => sameId(option.id, id)),
  );
  const unavailable = field.type === 'person' ? UNAVAILABLE_MEMBER() : UNAVAILABLE_OPTION();
  return ids.map((id) => {
    const unknownIndex = unknownIds.findIndex((unknown) => sameId(unknown, id));
    if (unknownIndex >= 0) {
      const label = unknownIds.length > 1 ? `${unavailable} ${unknownIndex + 1}` : unavailable;
      return { id, label, state: 'unavailable', color: null };
    }
    if (field.type === 'person') {
      const member = members.find((candidate) => sameId(candidate.id, id));
      return { id, label: member?.displayName ?? unavailable, state: 'active', color: null };
    }
    const option = field.options.find((candidate) => sameId(candidate.id, id));
    const archived = option !== undefined && option.archivedAt !== null;
    return {
      id,
      label: archived ? t('fields.valueDraft.valueArchived', { p0: option?.name ?? '' }) : (option?.name ?? unavailable),
      state: archived ? 'archived' : 'active',
      color: option?.color ?? null,
    };
  });
}
