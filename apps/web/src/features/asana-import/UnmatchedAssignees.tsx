import type { AssigneeConflict } from '../../lib/api';
import { useTranslation } from '../../i18n';
import type { AssigneeAction } from './api';

/** One choice per unmatched person. `reassign` without a teammate yet is held here as an incomplete choice. */
export type AssigneeChoice = { action: 'skip' | 'unassign' } | { action: 'reassign'; membershipId: string };
export const defaultChoices = (conflict: AssigneeConflict): Record<string, AssigneeChoice> =>
  Object.fromEntries(conflict.people.map(person => [person.email, { action: 'unassign' } satisfies AssigneeChoice]));
/** Every reassigned person needs a teammate before the files can be checked again. */
export const choicesComplete = (choices: Record<string, AssigneeChoice>) =>
  Object.values(choices).every(choice => choice.action !== 'reassign' || choice.membershipId !== '');
export const toActions = (choices: Record<string, AssigneeChoice>): Record<string, AssigneeAction> => choices;

const selectClass = 'w-full rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-ink';

export function UnmatchedAssignees({ conflict, choices, onChange, disabled }: { conflict: AssigneeConflict; choices: Record<string, AssigneeChoice>; onChange: (next: Record<string, AssigneeChoice>) => void; disabled: boolean }) {
  const { t } = useTranslation();
  const set = (email: string, choice: AssigneeChoice) => onChange({ ...choices, [email]: choice });
  return <section className="space-y-3 rounded-lg border border-amber-400/50 bg-amber-100/20 p-3 text-sm" aria-label={t('projects.asanaImport.unmatchedTitle')}>
    <h3 className="font-medium text-ink">{t('projects.asanaImport.unmatchedTitle')}</h3>
    <p className="text-muted">{t('projects.asanaImport.unmatchedHelp')}</p>
    <ul className="space-y-3">
      {conflict.people.map(person => {
        const choice = choices[person.email] ?? { action: 'unassign' };
        const label = t('projects.asanaImport.actionFor', { name: person.name });
        return <li key={person.email} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] sm:items-start">
          <div className="min-w-0"><p className="truncate font-medium text-ink">{person.name}</p><p className="truncate text-xs text-muted">{person.email} · {t('projects.asanaImport.taskCount', { count: person.taskCount })}</p></div>
          <div className="space-y-1">
            <select aria-label={label} className={selectClass} disabled={disabled} value={choice.action}
              onChange={event => { const action = event.target.value; set(person.email, action === 'reassign' ? { action, membershipId: '' } : action === 'skip' ? { action } : { action: 'unassign' }); }}>
              <option value="unassign">{t('projects.asanaImport.actionUnassign')}</option>
              <option value="skip">{t('projects.asanaImport.actionSkip')}</option>
              <option value="reassign" disabled={conflict.targets.length === 0}>{t('projects.asanaImport.actionReassign')}</option>
            </select>
            {choice.action === 'reassign' ? <select aria-label={t('projects.asanaImport.teammateFor', { name: person.name })} className={selectClass} disabled={disabled} value={choice.membershipId}
              onChange={event => set(person.email, { action: 'reassign', membershipId: event.target.value })}>
              <option value="">{t('projects.asanaImport.pickTeammate')}</option>
              {conflict.targets.map(target => <option key={target.membershipId} value={target.membershipId}>{target.label}</option>)}
            </select> : null}
          </div>
        </li>;
      })}
    </ul>
  </section>;
}
