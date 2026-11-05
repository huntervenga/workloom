export type DueBucket = 'overdue' | 'today' | 'tomorrow' | 'later' | 'none';

const day = (date: string) => Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);

/** Where a due date falls relative to today (plain dates): overdue, today, tomorrow, later, or undated. */
export function dueBucket(dueDate: string | null, today: string): DueBucket {
  if (dueDate === null) return 'none';
  const distance = day(dueDate) - day(today);
  if (distance < 0) return 'overdue';
  if (distance === 0) return 'today';
  return distance === 1 ? 'tomorrow' : 'later';
}
