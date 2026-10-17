import { screen, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';

export type FilterPickerLabel = 'Task completion' | 'Task status' | 'Task participant' | 'Task tag';

/** The custom filter picker trigger. Its visible text is the selected choice. */
export const filterPicker = (label: FilterPickerLabel) => screen.getByRole('combobox', { name: label });

/** The open menu of a filter picker. */
export const filterMenu = (label: FilterPickerLabel) => within(screen.getByRole('listbox', { name: label }));

/** Opens a filter picker and makes one explicit choice by its visible option name. */
export async function chooseFilter(user: UserEvent, label: FilterPickerLabel, option: string) {
  await user.click(filterPicker(label));
  await user.click(filterMenu(label).getByRole('option', { name: option }));
}

/** The visible option names of a filter picker, in order. The menu is closed again without a choice. */
export async function filterOptionNames(user: UserEvent, label: FilterPickerLabel): Promise<string[]> {
  await user.click(filterPicker(label));
  const names = filterMenu(label).getAllByRole('option').map(option => option.textContent ?? '');
  await user.keyboard('{Escape}');
  return names;
}
