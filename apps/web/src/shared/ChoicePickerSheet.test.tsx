import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { ChoicePicker, type ChoiceOption } from './ChoicePicker';

// jsdom has no layout or media queries: the phone query is stubbed; where the sheet lands stays in the browser gate.
const statuses: ChoiceOption[] = [
  { value: 'todo', label: 'To do' },
  { value: 'doing', label: 'In progress' },
  { value: 'done', label: 'Done' },
];
const many: ChoiceOption[] = Array.from({ length: 9 }, (_, index) => ({ value: `p${index}`, label: `Person ${index}` }));

function phone(matches: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches, media: query, onchange: null,
    addEventListener: () => undefined, removeEventListener: () => undefined,
    addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
  }));
}

afterEach(() => vi.unstubAllGlobals());

const menu = () => document.querySelector<HTMLElement>('[data-choice-picker-menu]');

it('opens a short list as a full-width bottom sheet on a phone, placed without measuring the trigger', async () => {
  phone(true);
  const user = userEvent.setup();
  const chosen = vi.fn();
  render(<ChoicePicker label="Status" value="todo" options={statuses} onValueChange={chosen} />);
  await user.click(screen.getByRole('combobox', { name: 'Status' }));
  const sheet = menu();
  expect(sheet?.dataset.sheet).toBe('bottom');
  expect(sheet?.style.left).toContain('8px');
  expect(sheet?.style.right).toContain('8px');
  expect(sheet?.style.top).toBe('auto');
  expect(sheet?.style.bottom).toContain('safe-area-inset-bottom');
  await user.click(screen.getByRole('option', { name: 'Done' }));
  expect(chosen).toHaveBeenCalledWith('done');
  expect(menu()).toBeNull();
});

it('puts a searchable list at the top on a phone, so the keyboard does not cover it', async () => {
  phone(true);
  const user = userEvent.setup();
  render(<ChoicePicker label="Assignee" value="" options={many} onValueChange={vi.fn()} />);
  await user.click(screen.getByRole('combobox', { name: 'Assignee' }));
  expect(menu()?.dataset.sheet).toBe('top');
  expect(menu()?.style.top).toContain('safe-area-inset-top');
  expect(screen.getByRole('combobox', { name: 'Search: Assignee' })).toHaveFocus();
});

it('keeps the anchored menu on wider screens', async () => {
  phone(false);
  const user = userEvent.setup();
  render(<ChoicePicker label="Status" value="todo" options={statuses} onValueChange={vi.fn()} />);
  await user.click(screen.getByRole('combobox', { name: 'Status' }));
  expect(menu()?.dataset.sheet).toBeUndefined();
  expect(menu()?.style.right).toBe('');
});
