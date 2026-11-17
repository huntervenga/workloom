import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { ChoicePicker, type ChoiceOption } from './ChoicePicker';

// jsdom has no layout: the phone viewport and the tapped field's box are stubbed; real placement stays in the browser gate.
const statuses: ChoiceOption[] = [
  { value: 'todo', label: 'To do' },
  { value: 'progress', label: 'In progress' },
  { value: 'done', label: 'Done' },
];
const field = { top: 300, bottom: 340, left: 200, right: 320, width: 120, height: 40, x: 200, y: 300 };

afterEach(() => vi.restoreAllMocks());

it('opens a list on a phone right under the tapped field, kept inside the screen, not as a sheet at the bottom', async () => {
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(390);
  vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(844);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return { ...field, toJSON: () => field, ...(this.getAttribute('role') === 'combobox' ? {} : { width: 0, height: 0 }) } as DOMRect;
  });
  const user = userEvent.setup();
  render(<ChoicePicker label="Status" value="todo" options={statuses} onValueChange={vi.fn()} />);
  await user.click(screen.getByRole('combobox', { name: 'Status' }));
  const menu = document.querySelector<HTMLElement>('[data-choice-picker-menu]');
  expect(menu?.dataset.sheet).toBeUndefined();
  expect(menu?.dataset.side).toBe('bottom');
  // 4px under the field; the 224px minimum width moves it left so it ends 8px inside the 390px screen.
  expect([menu?.style.top, menu?.style.left, menu?.style.width]).toEqual(['344px', '158px', '224px']);
});
