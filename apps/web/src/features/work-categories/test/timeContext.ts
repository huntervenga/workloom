import { screen, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { alphaMembers } from '../../../test/fakeApi';
import { MEMBER_ID, period } from '../../planning/test/fixtures';

export function timeContextLabel(label: string, value: string): string {
  if (label === 'Week for hours') {
    if (!value) return 'Choose a week explicitly';
    const selected = period(value);
    return `${selected.name} · ${selected.localStart}`;
  }
  const member = alphaMembers.find(item => item.id === value);
  if (!member) throw new Error(`Missing time-context member ${value}`);
  return `${member.displayName}${value === MEMBER_ID ? ' · me' : ''}`;
}

export async function chooseTimeContext(user: UserEvent, label: string, value: string) {
  await user.click(await screen.findByRole('combobox', { name: label }));
  await user.click(within(await screen.findByRole('listbox', { name: label })).getByRole('option', { name: timeContextLabel(label, value) }));
}
