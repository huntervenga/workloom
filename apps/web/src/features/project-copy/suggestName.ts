const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;

/** "42 week (since 19 October 2026) …" → "43 week (since 26 October 2026) …": next number and dates moved by `days`. */
export function suggestNextProjectName(name: string, days = 7): string {
  let next = name.replace(/^(\s*)(\d{1,4})(?=\D)/, (_match, space: string, digits: string) => `${space}${Number(digits) + 1}`);
  next = next.replace(new RegExp('\\b(\\d{1,2})\\s(' + MONTHS.join('|') + ')\\s(\\d{4})\\b', 'g'), (match, day: string, month: string, year: string) => {
    const moved = new Date(Date.UTC(Number(year), MONTHS.indexOf(month as (typeof MONTHS)[number]), Number(day) + days));
    return Number.isNaN(moved.getTime()) ? match : `${moved.getUTCDate()} ${MONTHS[moved.getUTCMonth()]} ${moved.getUTCFullYear()}`;
  });
  return next;
}
export const hasDateInName = (name: string) => new RegExp('\\b\\d{1,2}\\s(' + MONTHS.join('|') + ')\\s\\d{4}\\b').test(name);
