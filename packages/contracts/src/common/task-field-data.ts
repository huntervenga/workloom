import { z } from 'zod';

import { idSchema } from './ids.js';

/**
 * Typed custom field values, shared by `fields.ts` and contracts that embed a field value.
 *
 * The calendar date and minutes primitives are passed in instead of imported from `tasks.ts`, so
 * this module depends on neither `tasks.ts` nor `fields.ts` and either may import it without a
 * runtime import cycle.
 */

const MAX_NUMBER_VALUE = 1e12;
const MAX_REFERENCE_IDS = 100;

function hasUniqueIds(ids: readonly string[]): boolean {
  return new Set(ids).size === ids.length;
}

/**
 * String checks applied next to Zod's URL parser: the value must literally start with
 * `http://` or `https://` (so `http:host` is not accepted), contain no whitespace or control
 * characters (rejected rather than trimmed), and have no `user:password@` in its authority.
 * The authority ends at the first `/`, `?`, `#` or `\` (which http(s) parsers treat as `/`).
 */
function isPlainHttpUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value) || /\s/.test(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return false;
  }
  const authority = value.slice(value.indexOf('//') + 2).split(/[/?#\\]/, 1)[0] ?? '';
  return authority !== '' && !authority.includes('@');
}

/** Canonical ID set: lowercase (via `idSchema`), unique and sorted. */
const referenceIdListSchema = z
  .array(idSchema)
  .max(MAX_REFERENCE_IDS)
  .refine(hasUniqueIds, { error: 'IDs must be unique.' })
  .transform((ids) => [...ids].sort());

const textValueSchema = z.string().max(10_000);
const numberValueSchema = z.number().min(-MAX_NUMBER_VALUE).max(MAX_NUMBER_VALUE);
const httpUrlError = { error: 'Expected an http or https URL.' } as const;
/** The original string is checked first: `z.url` trims its input before parsing. */
const urlValueSchema = z
  .string()
  .max(2048)
  .refine(isPlainHttpUrl, httpUrlError)
  .pipe(z.url({ protocol: /^https?$/, ...httpUrlError }));

/**
 * Builds the typed field value union. Every type accepts `null` (an explicit clear), which is
 * distinct from `0`, `false`, `[]` and `''`. Text is kept verbatim (not trimmed). `duration` uses
 * `minutesSchema` and `date` uses `calendarDateSchema`; select and `person` values are IDs, never
 * labels. The generic parameters keep the exact primitive schema types in the result.
 */
export function createTaskFieldDataSchema<TDate extends z.ZodType<string>, TMinutes extends z.ZodType<number>>({
  calendarDateSchema,
  minutesSchema,
}: {
  calendarDateSchema: TDate;
  minutesSchema: TMinutes;
}) {
  return z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('text'), value: textValueSchema.nullable() }),
    z.strictObject({ type: z.literal('number'), value: numberValueSchema.nullable() }),
    z.strictObject({ type: z.literal('duration'), value: minutesSchema.nullable() }),
    z.strictObject({ type: z.literal('date'), value: calendarDateSchema.nullable() }),
    z.strictObject({ type: z.literal('single_select'), value: idSchema.nullable() }),
    z.strictObject({ type: z.literal('multi_select'), value: referenceIdListSchema.nullable() }),
    z.strictObject({ type: z.literal('person'), value: referenceIdListSchema.nullable() }),
    z.strictObject({ type: z.literal('boolean'), value: z.boolean().nullable() }),
    z.strictObject({ type: z.literal('url'), value: urlValueSchema.nullable() }),
  ]);
}
