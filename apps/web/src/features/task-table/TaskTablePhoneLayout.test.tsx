import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { PHONE_TABLE_QUERY, TaskTable } from './TaskTable';
import { makeMember, makeSection, makeTask, statuses } from './taskTableFixtures';

// jsdom has no layout or media queries: the phone query is stubbed, and the wrapping/widths stay in the browser gate.
const main = makeSection({ id: 'main', name: 'Launch preparation' });
const owner = makeMember({ id: 'owner', userId: 'user-owner', displayName: 'Synthetic Owner' });
const launch = makeTask({ id: 'launch', title: 'Prepare the launch checklist for the next team review', sectionId: main.id, responsibleMembershipId: owner.id });

function phone(matches: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: matches && query === PHONE_TABLE_QUERY, media: query, onchange: null,
    addEventListener: () => undefined, removeEventListener: () => undefined,
    addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
  }));
}

afterEach(() => vi.unstubAllGlobals());

function renderTable() {
  const calls = { onOpenTask: vi.fn(), onCreateTask: vi.fn(), onCreateChild: vi.fn(), onEditTaskField: vi.fn() };
  render(<TaskTable tasks={[launch]} sections={[main]} members={[owner]} statuses={statuses} {...calls} writable
    columnIds={['title', 'status', 'estimate']} />);
  return calls;
}

it('opens the task from a tap on its name on a phone, so renaming happens in the task pane', async () => {
  phone(true);
  const user = userEvent.setup();
  const calls = renderTable();
  await user.click(screen.getByRole('button', { name: launch.title }));
  expect(calls.onOpenTask).toHaveBeenCalledWith(launch.id);
  expect(calls.onEditTaskField).not.toHaveBeenCalled();
});

it('keeps renaming in place from a click on the name on wider screens', async () => {
  phone(false);
  const user = userEvent.setup();
  const wide = renderTable();
  await user.click(screen.getByRole('button', { name: launch.title }));
  expect(wide.onEditTaskField).toHaveBeenCalledWith(launch, 'title');
  expect(wide.onOpenTask).not.toHaveBeenCalled();
});

it('renames from the keyboard on a phone, where only a pointer tap opens the task', async () => {
  phone(true);
  const user = userEvent.setup();
  const calls = renderTable();
  screen.getByRole('button', { name: launch.title }).focus();
  await user.keyboard('{Enter}');
  expect(calls.onEditTaskField).toHaveBeenCalledWith(launch, 'title');
  expect(calls.onOpenTask).not.toHaveBeenCalled();
});
