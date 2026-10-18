import type { TaskDto } from '@workloom/contracts';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { alpha, alphaMembers, anna, installFakeApi } from '../../test/fakeApi';
import { renderFieldUi } from '../fields/test/fixtures';
import { lostResponse, rootPath, task } from '../planning/test/fixtures';
import { InlineTaskEdit } from '../tasks/InlineTaskEdit';
import type { TaskInlineField } from '../tasks/tableEditing';
import { useTaskCommands } from '../tasks/useTaskCommands';
import { TaskTable } from './TaskTable';
import { statuses } from './taskTableFixtures';

// jsdom has no layout: the browser caret hit-test is faked at the real pointer coordinates.
// Actual text hit-testing and geometry stay in the browser gate.
const launch: TaskDto = { ...task, title: 'Prepare launch' };
const columnIds = ['title', 'status', 'estimate'] as const;
const pointer = { clientX: 37, clientY: 21 };
const outsideText = 'Prepare launch notes outside the table';

type Hit = (x: number, y: number) => { node: Node; offset: number } | null;

function stubCaretPosition(hit: Hit) {
  Object.defineProperty(document, 'caretPositionFromPoint', { configurable: true, value: (x: number, y: number) => {
    const at = hit(x, y);
    return at && { offsetNode: at.node, offset: at.offset };
  } });
}

/** Legacy WebKit/Blink API: a collapsed Range at the hit. */
function stubCaretRange(hit: Hit) {
  Object.defineProperty(document, 'caretRangeFromPoint', { configurable: true, value: (x: number, y: number) => {
    const at = hit(x, y);
    if (!at) return null;
    const range = document.createRange();
    range.setStart(at.node, at.offset);
    range.collapse(true);
    return range;
  } });
}

afterEach(() => {
  Reflect.deleteProperty(document, 'caretPositionFromPoint');
  Reflect.deleteProperty(document, 'caretRangeFromPoint');
});

const titleButton = () => screen.getByRole('button', { name: launch.title });
/** The rendered title's own text node, hit only at the pointer's coordinates. */
const onTitleText = (offset: number): Hit => (x, y) =>
  x === pointer.clientX && y === pointer.clientY ? { node: titleButton().firstChild as Node, offset } : null;

interface OpenInline { taskId: string; field: TaskInlineField; focusClaim: { current: boolean }; titleCaret?: number | undefined; mount: number }

/** Page-shaped owner: like ProjectPage, each explicit open gets a fresh one-shot claim and its optional caret. */
function Harness({ opened }: { opened: (...args: unknown[]) => void }) {
  const commands = useTaskCommands(anna.id, alpha.id);
  const [active, setActive] = useState<OpenInline | null>(null);
  return <>
    <p>{outsideText}</p>
    <button type="button" onClick={() => setActive(before => before && { ...before, mount: before.mount + 1 })}>Remount editor</button>
    <TaskTable tasks={[launch]} sections={[]} members={alphaMembers} statuses={statuses} onOpenTask={vi.fn()} onCreateTask={vi.fn()} onCreateChild={vi.fn()} writable columnIds={columnIds}
      onEditTaskField={(...args: [TaskDto, TaskInlineField, number?]) => {
        opened(...args);
        const [row, field, titleCaret] = args;
        setActive({ taskId: row.id, field, focusClaim: { current: false }, titleCaret, mount: 0 });
      }}
      activeFieldEditor={active ? { taskId: active.taskId, field: active.field } : undefined}
      renderTaskFieldEditor={(row, field) => active && row.id === active.taskId && field === active.field
        ? <InlineTaskEdit key={active.mount} focusClaim={active.focusClaim} {...(active.titleCaret === undefined ? {} : { titleCaret: active.titleCaret })}
          task={row} field={field} statuses={statuses} members={alphaMembers} commands={commands} writable
          onClose={() => setActive(null)} onMoreDetails={() => undefined} onSaved={() => undefined} />
        : null} />
  </>;
}

function renderHarness() {
  const opened = vi.fn();
  const ui = renderFieldUi(<Harness opened={opened} />);
  const row = titleButton().closest('tr');
  if (!row) throw Error('Task row required.');
  const editor = () => within(row).getByRole<HTMLInputElement>('textbox');
  const clickTitle = () => { fireEvent.click(titleButton(), { detail: 1, ...pointer }); return editor(); };
  return { ...ui, opened, row, editor, clickTitle };
}

describe('title caret from the clicked character', () => {
  it('opens the real title editor with the caret at the clicked character, types there and plain Escape still closes unsaved', async () => {
    const api = installFakeApi({});
    stubCaretPosition(onTitleText(3));
    const view = renderHarness();
    const input = view.clickTitle();
    expect(input).toHaveValue(launch.title);
    expect(input).toHaveFocus();
    expect([input.selectionStart, input.selectionEnd]).toEqual([3, 3]);
    expect(view.opened).toHaveBeenCalledExactlyOnceWith(launch, 'title', 3);

    await view.user.keyboard('X');
    expect(input).toHaveValue('PreXpare launch');
    expect([input.selectionStart, input.selectionEnd]).toEqual([4, 4]);

    await view.user.keyboard('{Escape}');
    expect(within(view.row).queryByRole('textbox')).not.toBeInTheDocument();
    expect(titleButton()).toHaveTextContent(launch.title);
    expect(api.calls.filter(call => call.method === 'PATCH')).toEqual([]);
  });

  it('keeps keyboard activation on the existing two-argument open and default caret, unlike a pointer click', async () => {
    installFakeApi({});
    // A hit that would land mid-title at any coordinates: keyboard activation must never consult it.
    stubCaretPosition(() => ({ node: titleButton().firstChild as Node, offset: 3 }));
    const view = renderHarness();
    for (const key of ['{Enter}', ' ']) {
      titleButton().focus();
      await view.user.keyboard(key);
      const input = view.editor();
      expect(input).toHaveFocus();
      expect([input.selectionStart, input.selectionEnd]).toEqual([launch.title.length, launch.title.length]);
      expect(view.opened.mock.lastCall).toHaveLength(2);
      expect(view.opened.mock.lastCall).toEqual([launch, 'title']);
      await view.user.keyboard('{Escape}');
      expect(within(view.row).queryByRole('textbox')).not.toBeInTheDocument();
    }
    expect(view.opened).toHaveBeenCalledTimes(2);

    const input = view.clickTitle();
    expect([input.selectionStart, input.selectionEnd]).toEqual([3, 3]);
    expect(view.opened.mock.lastCall).toEqual([launch, 'title', 3]);
  });

  it('falls back to the default caret for a hit outside the title or no caret answer, and accepts the legacy range API', async () => {
    installFakeApi({});
    const view = renderHarness();
    const outside = screen.getByText(outsideText).firstChild as Node;
    const fallbacks: ReadonlyArray<() => void> = [
      // Same characters, but not the title button's text.
      () => stubCaretPosition(() => ({ node: outside, offset: 3 })),
      () => stubCaretPosition(() => null),
      () => { Reflect.deleteProperty(document, 'caretPositionFromPoint'); },
    ];
    for (const install of fallbacks) {
      install();
      const input = view.clickTitle();
      expect(input).toHaveFocus();
      expect([input.selectionStart, input.selectionEnd]).toEqual([launch.title.length, launch.title.length]);
      expect(view.opened.mock.lastCall?.[2]).toBeUndefined();
      await view.user.keyboard('{Escape}');
      expect(within(view.row).queryByRole('textbox')).not.toBeInTheDocument();
    }

    stubCaretRange(onTitleText(3));
    const input = view.clickTitle();
    expect(input).toHaveFocus();
    expect([input.selectionStart, input.selectionEnd]).toEqual([3, 3]);
    expect(view.opened.mock.lastCall).toEqual([launch, 'title', 3]);
  });

  it('applies the caret once: a remount with the consumed claim and a late lost ACK keep outside focus and never reapply it', async () => {
    const first = lostResponse();
    const api = installFakeApi({ [`PATCH ${rootPath}/tasks/${task.id}`]: () => first.promise });
    stubCaretPosition(onTitleText(3));
    const view = renderHarness();
    const opened = view.clickTitle();
    expect([opened.selectionStart, opened.selectionEnd]).toEqual([3, 3]);
    await view.user.keyboard('X');
    expect(opened).toHaveValue('PreXpare launch');

    // Leaving the editor commits the draft; the held request keeps the editor mounted.
    const remount = screen.getByRole('button', { name: 'Remount editor' });
    await view.user.click(remount);
    await waitFor(() => expect(api.calls.filter(call => call.method === 'PATCH')).toHaveLength(1));
    const remounted = view.editor();
    expect(remounted).not.toBe(opened);
    expect(remounted).toHaveValue('PreXpare launch');
    expect(remount).toHaveFocus();
    expect([remounted.selectionStart, remounted.selectionEnd]).toEqual([remounted.value.length, remounted.value.length]);

    await act(async () => first.lose());
    await screen.findByRole('button', { name: 'Retry' });
    expect(remount).toHaveFocus();
    const recovered = view.editor();
    expect([recovered.selectionStart, recovered.selectionEnd]).toEqual([recovered.value.length, recovered.value.length]);
  });
});
