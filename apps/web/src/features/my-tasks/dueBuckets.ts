export type DueBucket = 'overdue' | 'today' | 'week' | 'later' | 'none';

const day = (date: string) => Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);

/** Where a due date falls relative to today (plain dates): overdue, today, within the next six days, later, or undated. */
export function dueBucket(dueDate: string | null, today: string): DueBucket {
  if (dueDate === null) return 'none';
  const distance = day(dueDate) - day(today);
  if (distance < 0) return 'overdue';
  if (distance === 0) return 'today';
  return distance <= 6 ? 'week' : 'later';
}

/** The browser's current calendar date as YYYY-MM-DD. */
export function localToday(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
