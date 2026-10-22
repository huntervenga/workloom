import { Temporal } from 'temporal-polyfill';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Calendar date moved by whole days; years outside the supported range keep the original text. */
export function shiftDate(date: string, days: number): string {
  if (days === 0 || !DATE.test(date)) return date;
  try {
    const moved = Temporal.PlainDate.from(date).add({ days }).toString();
    return moved >= '1900-01-01' && moved <= '2200-12-31' ? moved : date;
  } catch { return date; }
}

/**
 * A deterministic UUID for "the copy of this thing in this operation": a retry of the same copy derives the same ids, so
 * each step's idempotent replay sees exactly the same input.
 */
export function derivedId(digest: (value: string) => string, seed: string, original: string): string {
  const hex = digest(`${seed}\u0000${original.toLowerCase()}`);
  const variant = ((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Re-targets a settings document at the copy: every UUID found in `ids` is replaced (project, field, option, section and
 * status ids, rule ids), and every `{ from, to }` pair of calendar dates moves by `shiftDays`. People and tags are
 * workspace-level, so they are left exactly as they are.
 */
export function remapSettings<T>(value: T, ids: ReadonlyMap<string, string>, shiftDays: number): T {
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return UUID.test(node) ? ids.get(node.toLowerCase()) ?? node : node;
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const source = node as Record<string, unknown>;
      const isRange = typeof source.from === 'string' && typeof source.to === 'string' && DATE.test(source.from) && DATE.test(source.to);
      return Object.fromEntries(Object.entries(source).map(([key, item]) => [key, isRange && (key === 'from' || key === 'to') ? shiftDate(item as string, shiftDays) : walk(item)]));
    }
    return node;
  };
  return walk(value) as T;
}

/** "42 week (since 19 October 2026) …" → "43 week (since 26 October 2026) …": next number, dates moved by `days`. */
export function suggestNextProjectName(name: string, days = 7): string {
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  let next = name.replace(/^(\s*)(\d{1,4})(?=\D)/, (_m, space: string, digits: string) => `${space}${Number(digits) + 1}`);
  next = next.replace(new RegExp(`\\b(\\d{1,2}) (${months.join('|')}) (\\d{4})\\b`, 'g'), (match, day: string, month: string, year: string) => {
    try {
      const moved = Temporal.PlainDate.from({ year: Number(year), month: months.indexOf(month) + 1, day: Number(day) }).add({ days });
      return `${moved.day} ${months[moved.month - 1]} ${moved.year}`;
    } catch { return match; }
  });
  return next === name ? `${name} (copy)` : next;
}
