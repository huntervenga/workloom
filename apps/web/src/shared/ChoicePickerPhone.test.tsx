import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChoicePicker, type ChoiceOption } from './ChoicePicker';

// jsdom has no layout: the phone viewport and the boxes are stubbed; real placement stays in the browser gate.
const statuses: ChoiceOption[] = [
  { value: 'todo', label: 'To do' },
  { value: 'progress', label: 'In progress' },
  { value: 'done', label: 'Done' },
];
type Box = { top: number; left: number; width: number; height: number };
const rect = ({ top, left, width, height }: Box) => ({ top, left, width, height, x: left, y: top, right: left + width, bottom: top + height, toJSON: () => ({}) }) as DOMRect;
const field: Box = { top: 300, left: 200, width: 120, height: 40 };
// iOS WebKit was seen to report a fixed menu's previous box right after it moved: here, the top-left corner.
const staleMenu: Box = { top: 0, left: 0, width: 224, height: 150 };
let pane: Box = { top: 0, left: 0, width: 390, height: 844 };

beforeEach(() => {
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(390);
  vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(844);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.getAttribute('role') === 'combobox') return rect(field);
    if (this.getAttribute('role') === 'dialog') return rect(pane);
    if (this.hasAttribute('data-choice-picker-menu')) return rect(staleMenu);
    return rect({ top: 0, left: 0, width: 0, height: 0 });
  });
});
afterEach(() => vi.restoreAllMocks());

async function open() {
  await userEvent.setup().click(screen.getByRole('combobox', { name: 'Status' }));
  const menu = document.querySelector<HTMLElement>('[data-choice-picker-menu]');
  return { side: menu?.dataset.side, sheet: menu?.dataset.sheet, place: [menu?.style.top, menu?.style.left, menu?.style.width] };
}

it('opens a list on a phone right under the tapped field, inside the screen, whatever box the moved menu reports', async () => {
  render(<ChoicePicker label="Status" value="todo" options={statuses} onValueChange={vi.fn()} />);
  // 4px under the field; the 224px minimum width moves it left so it ends 8px inside the 390px screen.
  // A correction measured from the stale box would have put it at 688px / 316px instead.
  expect(await open()).toEqual({ side: 'bottom', sheet: undefined, place: ['344px', '158px', '224px'] });
});

it('places a list in a translated pane against the pane, scrolled or not, without measuring the menu', async () => {
  pane = { top: 100, left: 20, width: 370, height: 744 };
  render(<div role="dialog" aria-label="Task" style={{ transform: 'translateX(0px)' }}><ChoicePicker label="Status" value="todo" options={statuses} onValueChange={vi.fn()} /></div>);
  expect((await open()).place).toEqual(['244px', '138px', '224px']);
  await userEvent.setup().keyboard('{Escape}');
  // A scrolled pane carries its fixed descendants with its content.
  Object.defineProperty(screen.getByRole('dialog', { name: 'Task' }), 'scrollTop', { configurable: true, value: 50 });
  expect((await open()).place).toEqual(['294px', '138px', '224px']);
});
