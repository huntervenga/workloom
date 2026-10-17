import { screen, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { alphaMembers } from '../../../test/fakeApi';
import { period } from './fixtures';

/** Visible option text of the weekly Period picker for a fixture period ('' is the explicit empty choice). */
export function periodLabel(id: string): string {
  if (!id) return 'Choose a week';
  const selected = period(id);
  const last = new Date(`${selected.localEndExclusive}T12:00:00Z`);
  last.setUTCDate(last.getUTCDate() - 1);
  return `${selected.name} · ${selected.localStart} — ${last.toISOString().slice(0, 10)}`;
}

/** Visible option text of the Time entry for picker; an unknown carried ID stays visible as unavailable. */
export function personLabel(id: string): string {
  if (!id) return 'Choose a person';
  return alphaMembers.find(member => member.id === id)?.displayName ?? 'Selected person · unavailable';
}

/** Chooses one option of a ChoicePicker through its real trigger and listbox. */
export async function choosePicker(user: UserEvent, label: string | RegExp, option: string | RegExp): Promise<void> {
  await user.click(screen.getByRole('combobox', { name: label }));
  await user.click(within(await screen.findByRole('listbox', { name: label })).getByRole('option', { name: option }));
}

export const periodPicker = () => screen.getByLabelText('Period', { exact: true });
export const personPicker = () => screen.getByLabelText('Time entry for', { exact: true });
export const choosePeriod = (user: UserEvent, id: string) => choosePicker(user, 'Period', periodLabel(id));
export const choosePerson = (user: UserEvent, id: string) => choosePicker(user, 'Time entry for', personLabel(id));
