import { expect, it } from 'vitest';
import { rowShortcut } from './rowShortcuts';

it('dispatches shifted row commands and leaves typing and modified keys alone', () => {
  const row = document.createElement('tr');
  const cell = row.insertCell();
  const button = cell.appendChild(document.createElement('button'));
  const input = cell.appendChild(document.createElement('input'));
  const handled: unknown[] = [];
  row.addEventListener('keydown', event => handled.push(rowShortcut(event, row)));
  const send = (target: Element, init: KeyboardEventInit) => target.dispatchEvent(new KeyboardEvent('keydown', { ...init, bubbles: true }));
  send(button, { key: 'D', code: 'KeyD', shiftKey: true });
  send(input, { key: 'D', code: 'KeyD', shiftKey: true });
  send(button, { key: 'D', code: 'KeyD', shiftKey: true, ctrlKey: true });
  send(button, { key: '?' });
  expect(handled).toEqual(['date', null, null, 'help']);
});
