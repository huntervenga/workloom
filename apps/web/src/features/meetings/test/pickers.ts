import { within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';

/** Visible option names of the individual attendance outcome picker. */
export const outcomeOption = { unknown: 'Unconfirmed', present: 'Attended entire meeting', partial: 'Attended part of meeting', absent: 'Absent · 0 minutes', void: 'Void time entry' } as const;
/** Visible option names of the absence-basis pickers. */
export const basisOption = { planned_absence: 'Planned absence · no actual start required', actual_meeting: 'Meeting that took place' } as const;

/**
 * Chooses an option through the shared ChoicePicker the way a pointer user does. The menu is
 * portalled into the enclosing dialog, so `scope` may be that dialog or `document.body`.
 */
export async function choosePicker(user: UserEvent, scope: HTMLElement, label: string, option: string) {
  await user.click(within(scope).getByRole('combobox', { name: label }));
  await user.click(within(await within(scope).findByRole('listbox', { name: label })).getByRole('option', { name: option }));
}
