import type { TagDto, TaskDto } from '@workloom/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { alpha, alphaMembers, anna, created, deferred, failure, installFakeApi, ok } from '../../test/fakeApi';
import { renderFieldUi } from '../fields/test/fixtures';
import { rootPath, task } from '../planning/test/fixtures';
import { useInlineTagCreateBinding, type InlineTagOrigin } from './inlineTagCreate';
import { InlineTaskEdit } from './InlineTaskEdit';
import { TaskCommandRecovery } from './TaskCommandRecovery';
import { TaskTagPicker } from './TaskTagPicker';
import { useTaskCommands, type TaskCommands } from './useTaskCommands';

const design: TagDto = { id: 'f7000000-0000-4000-8000-000000000001', workspaceId: alpha.id, name: 'Design', color: '#6366f1', revision: 1, archivedAt: null };
const research: TagDto = { ...design, id: 'f7000000-0000-4000-8000-000000000009', name: 'Research', color: null };
const source: TaskDto = { ...task, startDate: null, dueDate: '2027-03-20', tags: [] };
const tagsPath = `${rootPath}/tags`;
const taskPath = `${rootPath}/tasks/${source.id}`;
const CONTINUE = 'Continue without this tag';
const UUID = /^[0-9a-f-]{36}$/i;

type Call = { method: string; path: string; body?: unknown; headers: Headers };
const tagPosts = (calls: Call[]) => calls.filter(call => call.method === 'POST' && call.path === tagsPath);
const taskPatches = (calls: Call[]) => calls.filter(call => call.method === 'PATCH' && call.path === taskPath);
const keyOf = (call: Call | undefined) => call?.headers.get('Idempotency-Key');

interface Committed {
  commands: { current: TaskCommands | null };
  setTagRights: { current: ((value: boolean) => void) | null };
}

function committedHandles(committed: Committed) {
  const commands = () => {
    if (committed.commands.current === null) throw new Error('Harness has not committed yet');
    return committed.commands.current;
  };
  // A role change arriving from the background, not from a click that could blur the owner.
  const setTagRights = async (value: boolean) => {
    const set = committed.setTagRights.current;
    if (set === null) throw new Error('Harness has not committed yet');
    await act(async () => set(value));
  };
  const recovery = () => screen.getByRole('status', { name: 'Inline tag creation' });
  const search = () => screen.getByRole('searchbox', { name: 'Search tags' });
  return { commands, setTagRights, recovery, search };
}

function inlineSetup() {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  const onMoreDetails = vi.fn();
  const onResumeCreate = vi.fn();
  const onOpenTask = vi.fn();
  const committed: Committed = { commands: { current: null }, setTagRights: { current: null } };
  function Example() {
    const [canCreate, setCanCreate] = useState(true);
    const commands = useTaskCommands(anna.id, alpha.id, canCreate);
    useEffect(() => { committed.commands.current = commands; committed.setTagRights.current = setCanCreate; }, [commands]);
    return <>
      <main tabIndex={-1}>
        <InlineTaskEdit task={source} field="tagIds" tags={[design]} statuses={[]} members={alphaMembers} commands={commands} writable
          onClose={onClose} onMoreDetails={onMoreDetails} onSaved={onSaved} />
      </main>
      <TaskCommandRecovery commands={commands} onResumeCreate={onResumeCreate} onOpenTask={onOpenTask} showTaskRecovery />
    </>;
  }
  const ui = renderFieldUi(<Example />);
  const popup = () => screen.getByRole('dialog', { name: 'Edit tags' });
  return { ...ui, ...committedHandles(committed), popup, onSaved, onClose, onMoreDetails, onResumeCreate, onOpenTask };
}

interface RowProps {
  commands: TaskCommands;
  origin: InlineTagOrigin;
  values: string[];
  setValues: (update: (current: string[]) => string[]) => void;
  onSubmit: (values: string[]) => void;
}

// A local draft form with no blur writer: only an explicit Add task submits.
function Row({ commands, origin, values, setValues, onSubmit }: RowProps) {
  const binding = useInlineTagCreateBinding(commands.inlineTags, {
    origin, canAttach: true,
    onSelect: tag => setValues(current => current.includes(tag.id) ? current : [...current, tag.id]),
  });
  return <form aria-label="Draft row" onSubmit={event => { event.preventDefault(); if (!commands.inlineTags.isHeld(origin.id)) onSubmit([...values]); }}>
    <TaskTagPicker tags={[design, ...commands.createdTags]} values={values} onChange={next => setValues(() => next)} creation={binding} onRequestClose={() => undefined} />
    <button type="submit">Add task</button>
    <span data-testid="held">{String(binding.held)}</span>
  </form>;
}

const rowOrigin: InlineTagOrigin = { id: 'create:row-a', taskId: null, label: 'Draft A' };

function rowSetup() {
  const onSubmit = vi.fn();
  const onResumeCreate = vi.fn();
  const onOpenTask = vi.fn();
  const committed: Committed = { commands: { current: null }, setTagRights: { current: null } };
  function Harness() {
    const [canCreate, setCanCreate] = useState(true);
    const [shown, setShown] = useState(true);
    const [values, setValues] = useState<string[]>([]);
    const commands = useTaskCommands(anna.id, alpha.id, canCreate);
    useEffect(() => { committed.commands.current = commands; committed.setTagRights.current = setCanCreate; }, [commands]);
    return <>
      {shown ? <Row commands={commands} origin={rowOrigin} values={values} setValues={setValues} onSubmit={onSubmit} /> : null}
      <TaskCommandRecovery commands={commands} onResumeCreate={onResumeCreate} onOpenTask={onOpenTask} showTaskRecovery />
      <p data-testid="values">{values.join(',')}</p>
      <button type="button" onClick={() => setShown(value => !value)}>Toggle picker</button>
    </>;
  }
  const ui = renderFieldUi(<Harness />);
  const values = () => screen.getByTestId('values').textContent;
  const form = () => screen.getByRole('form', { name: 'Draft row' });
  return { ...ui, ...committedHandles(committed), values, form, onSubmit, onResumeCreate, onOpenTask };
}

describe('continuing a draft without an unknown inline tag', () => {
  it('detaches an unknown create inside a saved task editor and saves only the explicitly kept tags', async () => {
    const { calls } = installFakeApi({
      [`POST ${tagsPath}`]: () => failure(503, 'UNAVAILABLE', 'Try again'),
      [`PATCH ${taskPath}`]: () => ok({ ...source, tags: [design], revision: source.revision + 1 }),
    });
    const ui = inlineSetup();
    await ui.user.click(within(ui.popup()).getByRole('checkbox', { name: 'Design' }));
    await ui.user.type(ui.search(), 'Research');
    await ui.user.keyboard('{Enter}');
    await within(ui.popup()).findByRole('button', { name: 'Retry creating tag' });
    expect(tagPosts(calls)).toHaveLength(1);
    expect(tagPosts(calls)[0]?.body).toEqual({ name: 'Research', color: null });
    const key = keyOf(tagPosts(calls)[0]);
    expect(key).toMatch(UUID);
    const uncertain = ui.commands().createTag.uncertain?.variables;
    expect(uncertain).toMatchObject({ input: { name: 'Research', color: null }, idempotencyKey: key });
    const controller = ui.commands().inlineTags;
    const originId = controller.current()?.origin.id;
    expect(originId).toMatch(new RegExp(`^edit:${source.id}:`));
    if (originId === undefined) throw new Error('No inline attempt');

    // Owner becomes a member: the task stays writable, only tag creation is lost.
    await ui.setTagRights(false);
    const retry = within(ui.popup()).getByRole('button', { name: 'Retry creating tag' });
    expect(retry).toHaveAttribute('aria-disabled', 'true');
    await ui.user.click(retry);
    expect(controller.isHeld(originId)).toBe(true);
    await ui.user.click(within(ui.popup()).getByRole('button', { name: 'Save' }));
    expect(taskPatches(calls)).toHaveLength(0);
    expect(tagPosts(calls)).toHaveLength(1);

    // While the picker owns the attempt, only it offers the way out; the page notice does not.
    expect(within(ui.popup()).getAllByRole('button', { name: CONTINUE })).toHaveLength(1);
    expect(within(ui.recovery()).queryByRole('button', { name: CONTINUE })).not.toBeInTheDocument();
    await ui.user.click(within(ui.popup()).getByRole('button', { name: CONTINUE }));
    expect(ui.search()).toHaveFocus();
    expect(document.activeElement).not.toBe(document.body);
    expect(screen.queryByRole('button', { name: CONTINUE })).not.toBeInTheDocument();
    expect(ui.search()).toHaveValue('Research');
    expect(controller.isHeld(originId)).toBe(false);
    expect(controller.busyFor(originId)).toBe(true);
    expect(controller.current()).toMatchObject({ status: 'unknown', name: 'Research', origin: { id: originId }, tag: null });
    expect(ui.commands().createTag.uncertain?.variables).toBe(uncertain);
    expect(uncertain).toMatchObject({ input: { name: 'Research', color: null }, idempotencyKey: key });
    expect(tagPosts(calls)).toHaveLength(1);
    expect(taskPatches(calls)).toHaveLength(0);

    await ui.user.clear(ui.search());
    expect(within(ui.popup()).getByRole('checkbox', { name: 'Design' })).toBeChecked();
    expect(within(ui.popup()).queryByRole('checkbox', { name: 'Research' })).not.toBeInTheDocument();
    expect(taskPatches(calls)).toHaveLength(0);

    await ui.user.click(within(ui.popup()).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(ui.onSaved).toHaveBeenCalledTimes(1));
    expect(taskPatches(calls)).toHaveLength(1);
    expect(taskPatches(calls)[0]?.body).toEqual({ expectedRevision: source.revision, tagIds: [design.id] });
    expect(ui.onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: source.id, revision: source.revision + 1, tags: [design] }));
    expect(tagPosts(calls)).toHaveLength(1);
    expect(controller.current()).toMatchObject({ status: 'unknown', tag: null });
  });

  it('keeps every new create blocked after detaching, and a later explicit retry only fills the catalog', async () => {
    const second = deferred<Response>();
    let attempts = 0;
    const { calls } = installFakeApi({ [`POST ${tagsPath}`]: () => ++attempts === 1 ? failure(503, 'UNAVAILABLE', 'Try again') : second.promise });
    const ui = rowSetup();
    await ui.user.click(screen.getByRole('checkbox', { name: 'Design' }));
    expect(ui.values()).toBe(design.id);
    await ui.user.type(ui.search(), 'Research');
    await ui.user.keyboard('{Enter}');
    await within(ui.form()).findByRole('button', { name: 'Retry creating tag' });
    expect(tagPosts(calls)).toHaveLength(1);
    const body = tagPosts(calls)[0]?.body;
    const key = keyOf(tagPosts(calls)[0]);
    expect(body).toEqual({ name: 'Research', color: null });
    expect(key).toMatch(UUID);
    const controller = ui.commands().inlineTags;

    await ui.setTagRights(false);
    expect(within(ui.form()).getByRole('button', { name: 'Retry creating tag' })).toHaveAttribute('aria-disabled', 'true');
    await ui.user.click(within(ui.form()).getByRole('button', { name: CONTINUE }));
    expect(ui.search()).toHaveFocus();
    expect(ui.values()).toBe(design.id);
    expect(controller.isHeld(rowOrigin.id)).toBe(false);
    expect(screen.getByTestId('held')).toHaveTextContent('false');
    expect(controller.current()).toMatchObject({ status: 'unknown', origin: { id: rowOrigin.id } });
    expect(tagPosts(calls)).toHaveLength(1);

    // Rights come back: the original may be retried, but nothing new may start, not even here.
    await ui.setTagRights(true);
    expect(controller.canRetry()).toBe(true);
    expect(controller.busyFor(rowOrigin.id)).toBe(true);
    await ui.user.clear(ui.search());
    await ui.user.type(ui.search(), 'Other');
    const create = screen.getByRole('button', { name: 'Create tag “Other”' });
    expect(create).toHaveAttribute('aria-disabled', 'true');
    await ui.user.keyboard('{Enter}');
    await ui.user.click(create);
    expect(tagPosts(calls)).toHaveLength(1);
    expect(ui.onSubmit).not.toHaveBeenCalled();

    const retry = within(ui.form()).getByRole('button', { name: 'Retry creating tag' });
    expect(retry).not.toHaveAttribute('aria-disabled', 'true');
    await ui.user.click(retry);
    await waitFor(() => expect(tagPosts(calls)).toHaveLength(2));
    expect(tagPosts(calls)[1]?.body).toEqual(body);
    expect(keyOf(tagPosts(calls)[1])).toBe(key);
    expect(controller.current()).toMatchObject({ status: 'pending' });
    expect(controller.isHeld(rowOrigin.id)).toBe(false);
    expect(screen.getByTestId('held')).toHaveTextContent('false');
    await ui.user.click(screen.getByRole('button', { name: 'Add task' }));
    expect(ui.onSubmit).toHaveBeenCalledExactlyOnceWith([design.id]);

    await act(async () => second.resolve(created(research)));
    await waitFor(() => expect(controller.current()).toMatchObject({ status: 'created', added: false, tag: { id: research.id } }));
    await ui.user.clear(ui.search());
    expect(screen.getByRole('checkbox', { name: 'Research' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Design' })).toBeChecked();
    expect(ui.values()).toBe(design.id);
    expect(ui.onSubmit).toHaveBeenCalledTimes(1);
    expect(tagPosts(calls).map(call => call.body)).toEqual([{ name: 'Research', color: null }, { name: 'Research', color: null }]);
    expect(tagPosts(calls).map(keyOf)).toEqual([key, key]);
    expect(calls).toHaveLength(2);
  });

  it('continues from the page notice once the owner collapsed, then retries on a reopened owner without adding the tag', async () => {
    let attempts = 0;
    const { calls } = installFakeApi({ [`POST ${tagsPath}`]: () => ++attempts === 1 ? failure(503, 'UNAVAILABLE', 'Try again') : created(research) });
    const ui = rowSetup();
    await ui.user.click(screen.getByRole('checkbox', { name: 'Design' }));
    await ui.user.type(ui.search(), 'Research');
    await ui.user.keyboard('{Enter}');
    await within(ui.form()).findByRole('button', { name: 'Retry creating tag' });
    expect(tagPosts(calls)).toHaveLength(1);
    const body = tagPosts(calls)[0]?.body;
    const key = keyOf(tagPosts(calls)[0]);
    expect(key).toMatch(UUID);
    const uncertain = ui.commands().createTag.uncertain?.variables;
    expect(uncertain).toMatchObject({ input: { name: 'Research', color: null }, idempotencyKey: key });
    const controller = ui.commands().inlineTags;

    await ui.setTagRights(false);
    expect(within(ui.recovery()).queryByRole('button', { name: CONTINUE })).not.toBeInTheDocument();
    await ui.user.click(screen.getByRole('button', { name: 'Toggle picker' }));
    expect(screen.queryByRole('searchbox', { name: 'Search tags' })).not.toBeInTheDocument();
    expect(ui.values()).toBe(design.id);

    const resume = within(ui.recovery()).getByRole('button', { name: 'Open original draft' });
    await ui.user.click(within(ui.recovery()).getByRole('button', { name: CONTINUE }));
    expect(resume).toHaveFocus();
    expect(document.activeElement).not.toBe(document.body);
    expect(screen.queryByRole('button', { name: CONTINUE })).not.toBeInTheDocument();
    expect(ui.onResumeCreate).not.toHaveBeenCalled();
    expect(ui.onSubmit).not.toHaveBeenCalled();
    expect(controller.current()).toMatchObject({ status: 'unknown', origin: { id: rowOrigin.id } });
    expect(controller.isHeld(rowOrigin.id)).toBe(false);
    expect(ui.commands().createTag.uncertain?.variables).toBe(uncertain);
    expect(ui.values()).toBe(design.id);
    expect(tagPosts(calls)).toHaveLength(1);
    expect(calls).toHaveLength(1);

    await ui.setTagRights(true);
    await ui.user.click(screen.getByRole('button', { name: 'Toggle picker' }));
    expect(screen.getByTestId('held')).toHaveTextContent('false');
    await ui.user.click(within(ui.form()).getByRole('button', { name: 'Retry creating tag' }));
    await waitFor(() => expect(controller.current()).toMatchObject({ status: 'created', added: false, tag: { id: research.id } }));
    expect(ui.commands().createTag.uncertain).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Research' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Design' })).toBeChecked();
    expect(ui.values()).toBe(design.id);
    expect(ui.onSubmit).not.toHaveBeenCalled();
    expect(tagPosts(calls)).toHaveLength(2);
    expect(tagPosts(calls)[1]?.body).toEqual(body);
    expect(keyOf(tagPosts(calls)[1])).toBe(key);
    expect(calls).toHaveLength(2);
  });
});
