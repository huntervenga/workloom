import { sqlCalendarDateSchema, type MembershipDto } from '@workloom/contracts';
import { TASK_TITLE_MAX } from './taskDraft';

export interface PastedTask {
  title: string;
  responsibleMembershipId?: string;
  assigneeName?: string;
  dueDate?: string;
}
export type QuickPaste =
  | { kind: 'single' }
  | { kind: 'invalid'; line: number }
  | { kind: 'tooMany' }
  | { kind: 'preview'; tasks: PastedTask[] };

export function parseQuickPaste(text: string, members: readonly MembershipDto[]): QuickPaste {
  if (text.length > 40_000) return { kind: 'tooMany' };
  const rows = text.split(/\r\n|[\r\n]/).filter(line => line.trim());
  if (rows.length <= 1 && !text.includes('\t')) return { kind: 'single' };
  if (rows.length > 20) return { kind: 'tooMany' };
  const tasks: PastedTask[] = [];
  for (const [index, raw] of rows.entries()) {
    const cells = raw.split('\t').map(cell => cell.trim());
    const [title, assignee, dueDate] = cells;
    if (!title || title.length > TASK_TITLE_MAX || title.includes('\0') || cells.length > 3 ||
        (dueDate && !sqlCalendarDateSchema.safeParse(dueDate).success)) return { kind: 'invalid', line: index + 1 };
    const match = assignee ? members.filter(member => member.displayName.trim().toLowerCase() === assignee.toLowerCase()) : [];
    if (assignee && match.length !== 1) return { kind: 'invalid', line: index + 1 };
    const member = match[0];
    tasks.push({ title, ...(member ? { responsibleMembershipId: member.id, assigneeName: member.displayName } : {}), ...(dueDate ? { dueDate } : {}) });
  }
  return tasks.length ? { kind: 'preview', tasks } : { kind: 'single' };
}
