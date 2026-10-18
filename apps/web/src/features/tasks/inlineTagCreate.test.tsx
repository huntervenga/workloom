import type { TagDto } from '@workloom/contracts';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useEffect, useState, type KeyboardEvent } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { alpha, anna, beta, boris, created, deferred, failure, installFakeApi } from '../../test/fakeApi';
import { renderFieldUi } from '../fields/test/fixtures';
import { lostResponse, rootPath } from '../planning/test/fixtures';
import { isInlineTagCreateCommand, useInlineTagCreateBinding, type InlineTagController, type InlineTagOrigin, type InlineTagStartResult, type LeaseTarget } from './inlineTagCreate';
import { CreateTagDialog } from './TagDialogs';
import { TaskCommandRecovery } from './TaskCommandRecovery';
import { TaskTagPicker } from './TaskTagPicker';
import { useTaskCommands, type TaskCommands } from './useTaskCommands';

const design: TagDto = { id: 'f7000000-0000-4000-8000-000000000001', workspaceId: alpha.id, name: 'Design', color: '#6366f1', revision: 1, archivedAt: null };
const archived: TagDto = { ...design, id: 'f7000000-0000-4000-8000-000000000003', name: 'Old tag', color: null, archivedAt: '2026-10-01T09:00:00.000Z' };
const research: TagDto = { ...design, id: 'f7000000-0000-4000-8000-000000000009', name: 'Research', color: null };
const tagsPath = `${rootPath}/tags`;

interface RowProps {
  commands: TaskCommands;
  origin: InlineTagOrigin;
  tags: readonly TagDto[];
  values: string[];
  setValues: (update: (current: string[]) => string[]) => void;
  onSubmit: (values: string[]) => void;
  onClose: () => void;
  keys: string[];
  canAttach: boolean;
}

function Row({ commands, origin, tags, values, setValues, onSubmit, onClose, keys, canAttach }: RowProps) {
  const binding = useInlineTagCreateBinding(commands.inlineTags, {
    origin, canAttach,
    onSelect: tag => setValues(current => current.includes(tag.id) ? current : [...current, tag.id]),
  });
  return <form aria-label="Draft row" onKeyDown={(event: KeyboardEvent) => { keys.push(event.key); }}
    onSubmit={event => { event.preventDefault(); if (!commands.inlineTags.isHeld(origin.id)) onSubmit([...values]); }}>
    <TaskTagPicker tags={tags} values={values} onChange={next => setValues(() => next)} creation={binding} onRequestClose={onClose} />
    <button type="submit">Add task</button>
    <span data-testid="held">{String(binding.held)}</span>
  </form>;
}

function setup(options: { canCreate?: boolean; details?: boolean; canAttach?: boolean; hideTaskRecovery?: boolean } = {}) {
  const onSubmit = vi.fn();
  const onClose = vi.fn();
  const onDetailsCreated = vi.fn();
  const onOpenTask = vi.fn();
  const onResumeCreate = vi.fn();
  const keys: string[] = [];
  const committed: { current: TaskCommands | null } = { current: null };
  function Harness() {
    const [actorId, setActorId] = useState(anna.id);
    const [workspaceId, setWorkspaceId] = useState(alpha.id);
    const [canCreate, setCanCreate] = useState(options.canCreate ?? true);
    const [originId, setOriginId] = useState('create:row-a');
    const [shown, setShown] = useState(true);
    const commands = useTaskCommands(actorId, workspaceId, canCreate);
    useEffect(() => { committed.current = commands; });
    const [values, setValues] = useState<string[]>([]);
    const origin = { id: originId, taskId: null, label: originId === 'create:row-a' ? 'Draft A' : 'Draft B' };
    return <>
      {shown ? <Row commands={commands} origin={origin} tags={[design, archived, ...commands.createdTags]} values={values} setValues={setValues}
        onSubmit={onSubmit} onClose={onClose} keys={keys} canAttach={options.canAttach ?? true} /> : null}
      {options.details ? <CreateTagDialog mutation={commands.createTag} onCreated={onDetailsCreated} /> : null}
      <TaskCommandRecovery commands={commands} onResumeCreate={onResumeCreate} onOpenTask={onOpenTask} showTaskRecovery={!options.hideTaskRecovery} />
      <p data-testid="values">{values.join(',')}</p>
      <button type="button" onClick={() => setShown(value => !value)}>Toggle picker</button>
      <button type="button" onClick={() => { setOriginId('create:row-b'); setValues([]); }}>New buffer</button>
      <button type="button" onClick={() => setWorkspaceId(beta.id)}>Switch workspace</button>
      <button type="button" onClick={() => setActorId(boris.id)}>Switch actor</button>
      <button type="button" onClick={() => setCanCreate(false)}>Revoke tag rights</button>
    </>;
  }
  const ui = renderFieldUi(<Harness />);
  const values = () => screen.getByTestId('values').textContent;
  const search = () => screen.getByRole('searchbox', { name: 'Search tags' });
  const recovery = () => screen.getByRole('status', { name: 'Inline tag creation' });
  const commands = () => {
    if (committed.current === null) throw new Error('Harness has not committed yet');
    return committed.current;
  };
  return { ...ui, onSubmit, onClose, onDetailsCreated, onOpenTask, onResumeCreate, keys, values, search, recovery, commands };
}

const tagPosts = (calls: { method: string; path: string }[]) => calls.filter(call => call.method === 'POST' && call.path === tagsPath);

describe('inline workspace tag creation', () => {
  it('sends one command for a double press, holds only its owner and selects the confirmed tag locally', async () => {
    const reply = deferred<Response>();
    const { calls } = installFakeApi({ [`POST ${tagsPath}`]: () => reply.promise });
    const ui = setup();
    await ui.user.type(ui.search(), '  Research ');
    await ui.user.dblClick(screen.getByRole('button', { name: 'Create tag “Research”' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ method: 'POST', path: tagsPath, body: { name: 'Research', color: null } });
    expect(calls[0]?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/i);
    expect(screen.getByTestId('held')).toHaveTextContent('true');
    expect(screen.getByText('Creating workspace tag “Research”…')).toBeInTheDocument();
    await ui.user.click(screen.getByRole('button', { name: 'Add task' }));
    expect(ui.onSubmit).not.toHaveBeenCalled();
    expect(ui.values()).toBe('');
    await act(async () => reply.resolve(created(research)));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Research' })).toBeChecked());
    expect(ui.values()).toBe(research.id);
    expect(ui.search()).toHaveValue('');
    expect(screen.getByTestId('held')).toHaveTextContent('false');
    expect(screen.queryByRole('status', { name: 'Inline tag creation' })).not.toBeInTheDocument();
    await ui.user.click(screen.getByRole('button', { name: 'Add task' }));
    expect(ui.onSubmit).toHaveBeenCalledExactlyOnceWith([research.id]);
    expect(calls).toHaveLength(1);
  });

  it('merges a confirmed tag into toggles made while it was pending', async () => {
    const reply = deferred<Response>();
    const { calls } = installFakeApi({ [`POST ${tagsPath}`]: () => reply.promise });
    const ui = setup();
    await ui.user.type(ui.search(), 'Research');
    await ui.user.keyboard('{Enter}');
    await waitFor(() => expect(calls).toHaveLength(1));
    await ui.user.clear(ui.search());
    await ui.user.click(screen.getByRole('checkbox', { name: 'Design' }));
    expect(ui.values()).toBe(design.id);
    await act(async () => reply.resolve(created(research)));
    await waitFor(() => expect(ui.values()).toBe(`${design.id},${research.id}`));
    expect(screen.getByRole('checkbox', { name: 'Design' })).toBeChecked();
    expect(calls).toHaveLength(1);
  });

  it('keeps a newer search typed while a button-started create is pending and still selects the confirmed tag', async () => {
    const reply = deferred<Response>();
    const { calls } = installFakeApi({ [`POST ${tagsPath}`]: () => reply.promise });
    const ui = setup();
    await ui.user.type(ui.search(), 'Research');
    await ui.user.click(screen.getByRole('button', { name: 'Create tag “Research”' }));
    await waitFor(() => expect(tagPosts(calls)).toHaveLength(1));
    expect(ui.search()).toHaveFocus();
    await ui.user.clear(ui.search());
    await ui.user.type(ui.search(), 'Delivery');
    expect(screen.getByTestId('held')).toHaveTextContent('true');
    await ui.user.click(screen.getByRole('button', { name: 'Add task' }));
    expect(ui.onSubmit).not.toHaveBeenCalled();
    await act(async () => reply.resolve(created(research)));
    await waitFor(() => expect(ui.values()).toBe(research.id));
    expect(ui.search()).toHaveValue('Delivery');
    expect(screen.getByTestId('held')).toHaveTextContent('false');
    expect(ui.onSubmit).not.toHaveBeenCalled();
    expect(tagPosts(calls)).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it('keeps a 503 create unknown and retries the exact body and key only when asked', async () => {
    let attempts = 0;
    const { calls } = installFakeApi({ [`POST ${tagsPath}`]: () => ++attempts === 1 ? failure(503, 'UNAVAILABLE', 'Try again') : created(research) });
    const ui = setup();
    await ui.user.type(ui.search(), 'Research');
    await ui.user.keyboard('{Enter}');
    const form = screen.getByRole('form', { name: 'Draft row' });
    expect(await within(form).findByRole('button', { name: 'Retry creating tag' })).toBeInTheDocument();
    expect(calls).toHaveLength(1);
    expect(screen.getByTestId('held')).toHaveTextContent('true');
    expect(ui.values()).toBe('');
    await ui.user.click(screen.getByRole('button', { name: 'Add task' }));
    expect(ui.onSubmit).not.toHaveBeenCalled();
    expect(within(ui.recovery()).getByText('Tag “Research” from “Draft A” may or may not have been created.')).toBeInTheDocument();
    expect(within(ui.recovery()).queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();
    await ui.user.click(within(form).getByRole('button', { name: 'Retry creating tag' }));
    await waitFor(() => expect(ui.values()).toBe(research.id));
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body).toEqual(calls[0]?.body);
    expect(calls[1]?.headers.get('Idempotency-Key')).toBe(calls[0]?.headers.get('Idempotency-Key'));
  });

  it('keeps a lost create recoverable on the page after the picker collapses, without adding it on remount', async () => {
    const first = lostResponse(); let attempts = 0;
    const { calls } = installFakeApi({ [`POST ${tagsPath}`]: () => ++attempts === 1 ? first.promise : created(research) });
    // The inline tag notice is its own gate: it stays on the page even where task recovery is hidden.
    const ui = setup({ hideTaskRecovery: true });
    await ui.user.type(ui.search(), 'Research');
    await ui.user.keyboard('{Enter}');
    await waitFor(() => expect(calls).toHaveLength(1));
    await act(async () => first.lose());
    await ui.user.click(screen.getByRole('button', { name: 'Toggle picker' }));
    expect(screen.queryByRole('searchbox', { name: 'Search tags' })).not.toBeInTheDocument();
    await ui.user.click(within(ui.recovery()).getByRole('button', { name: 'Open original draft' }));
    expect(ui.onResumeCreate).toHaveBeenCalledTimes(1);
    expect(ui.onOpenTask).not.toHaveBeenCalled();
    await ui.user.click(within(ui.recovery()).getByRole('button', { name: 'Retry creating tag' }));
    await waitFor(() => expect(within(ui.recovery()).getByText('Tag “Research” was created in the workspace but not added to “Draft A”. Open it to select the tag.')).toBeInTheDocument());
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body).toEqual({ name: 'Research', color: null });
    expect(calls[1]?.headers.get('Idempotency-Key')).toBe(calls[0]?.headers.get('Idempotency-Key'));
    await ui.user.click(screen.getByRole('button', { name: 'Toggle picker' }));
    expect(screen.getByRole('checkbox', { name: 'Research' })).not.toBeChecked();
    expect(ui.values()).toBe('');
    expect(screen.getByText('Tag “Research” was created in the workspace but not added to this draft. Select it in the list if you still want it.')).toBeInTheDocument();
    await ui.user.click(screen.getByRole('checkbox', { name: 'Research' }));
    expect(ui.values()).toBe(research.id);
    expect(calls).toHaveLength(2);
  });

  it('gives a late answer only to the catalog once its row moved on to a new buffer', async () => {
    const reply = deferred<Response>();
    const { calls } = installFakeApi({ [`POST ${tagsPath}`]: () => reply.promise });
    const ui = setup();
    await ui.user.type(ui.search(), 'Research');
    await ui.user.keyboard('{Enter}');
    await waitFor(() => expect(calls).toHaveLength(1));
    await ui.user.click(screen.getByRole('button', { name: 'New buffer' }));
    expect(screen.getByTestId('held')).toHaveTextContent('false');
    expect(ui.search()).toHaveValue('');
    expect(screen.getByText('Tag “Research” from “Draft A” is still unresolved. Resolve it from the page notice first.')).toBeInTheDocument();
    await ui.user.click(screen.getByRole('button', { name: 'Add task' }));
    expect(ui.onSubmit).toHaveBeenCalledExactlyOnceWith([]);
    await act(async () => reply.resolve(created(research)));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Research' })).not.toBeChecked());
    expect(ui.values()).toBe('');
    expect(within(ui.recovery()).getByText(/not added to “Draft A”/)).toBeInTheDocument();
    expect(calls).toHaveLength(1);
  });

  it('drops an answer that arrives after the workspace changed', async () => {
    const reply = deferred<Response>();
    const { calls } = installFakeApi({ [`POST ${tagsPath}`]: () => reply.promise });
    const ui = setup();
    await ui.user.type(ui.search(), 'Research');
    await ui.user.keyboard('{Enter}');
    await waitFor(() => expect(calls).toHaveLength(1));
    await ui.user.click(screen.getByRole('button', { name: 'Switch workspace' }));
    expect(screen.getByTestId('held')).toHaveTextContent('false');
    expect(screen.queryByRole('status', { name: 'Inline tag creation' })).not.toBeInTheDocument();
    await act(async () => reply.resolve(created(research)));
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole('checkbox', { name: 'Research' })).not.toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Inline tag creation' })).not.toBeInTheDocument();
    expect(ui.values()).toBe('');
    expect(calls).toHaveLength(1);
  });

  it('drops an answer that arrives after the actor changed', async () => {
    const reply = deferred<Response>();
    const { calls } = installFakeApi({ [`POST ${tagsPath}`]: () => reply.promise });
    const ui = setup();
    await ui.user.type(ui.search(), 'Research');
    await ui.user.keyboard('{Enter}');
    await waitFor(() => expect(tagPosts(calls)).toHaveLength(1));
    await ui.user.click(screen.getByRole('button', { name: 'Switch actor' }));
    expect(screen.getByTestId('held')).toHaveTextContent('false');
    expect(screen.queryByRole('status', { name: 'Inline tag creation' })).not.toBeInTheDocument();
    await act(async () => reply.resolve(created(research)));
    await act(async () => { await Promise.resolve(); });
    expect(ui.commands().inlineTags.current()).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Research' })).not.toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Inline tag creation' })).not.toBeInTheDocument();
    expect(screen.queryByText(/not added to/)).not.toBeInTheDocument();
    expect(ui.values()).toBe('');
    expect(tagPosts(calls)).toHaveLength(1);
  });

  it('never hands an old lease answer to a new target published on the same ref without a release', async () => {
    const reply = deferred<Response>();
    const { calls } = installFakeApi({ [`POST ${tagsPath}`]: () => reply.promise });
    const ui = setup();
    const controller: InlineTagController = ui.commands().inlineTags;
    const originA: InlineTagOrigin = { id: 'create:lease-a', taskId: null, label: 'Lease A' };
    const onSelectA = vi.fn();
    const onSelectB = vi.fn();
    const onAttached = vi.fn();
    const target: { current: LeaseTarget } = { current: { originId: originA.id, canAttach: true, onSelect: onSelectA, onAttached } };
    const { lease, release } = controller.lease(originA.id, target);
    try {
      let result: InlineTagStartResult | undefined;
      act(() => { result = controller.start(originA, 'Research', [], lease); });
      expect(result).toBe('started');
      await waitFor(() => expect(tagPosts(calls)).toHaveLength(1));
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ method: 'POST', path: tagsPath, body: { name: 'Research', color: null } });
      expect(calls[0]?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/i);
      // The same ref now shows another origin; the old lease stays active and registered.
      target.current = { originId: 'create:lease-b', canAttach: true, onSelect: onSelectB, onAttached };
      await act(async () => reply.resolve(created(research)));
      await waitFor(() => expect(controller.current()).toMatchObject({ status: 'created', added: false, tag: { id: research.id } }));
      expect(onSelectA).not.toHaveBeenCalled();
      expect(onSelectB).not.toHaveBeenCalled();
      expect(onAttached).not.toHaveBeenCalled();
      expect(screen.getByRole('checkbox', { name: 'Research' })).not.toBeChecked();
      expect(ui.values()).toBe('');
      expect(tagPosts(calls)).toHaveLength(1);
    } finally {
      release();
    }
  });

  it('neither creates nor submits on a composing Enter, and plain Enter never submits the owner', async () => {
    const reply = deferred<Response>();
    const { calls } = installFakeApi({ [`POST ${tagsPath}`]: () => reply.promise });
    const ui = setup();
    await ui.user.type(ui.search(), 'Research');
    ui.keys.length = 0;
    fireEvent.keyDown(ui.search(), { key: 'Enter', keyCode: 229 });
    fireEvent.keyDown(ui.search(), { key: 'Enter', isComposing: true });
    expect(calls).toHaveLength(0);
    expect(ui.onSubmit).not.toHaveBeenCalled();
    expect(ui.keys).toEqual([]);
    expect(ui.search()).toHaveValue('Research');
    await ui.user.keyboard('{Enter}');
    await waitFor(() => expect(tagPosts(calls)).toHaveLength(1));
    expect(ui.onSubmit).not.toHaveBeenCalled();
    expect(ui.keys).toEqual([]);
  });

  it('lets the first Escape close only the picker and keeps the draft and search', async () => {
    const { calls } = installFakeApi({});
    const ui = setup();
    await ui.user.click(screen.getByRole('checkbox', { name: 'Design' }));
    await ui.user.type(ui.search(), 'Res');
    ui.keys.length = 0;
    await ui.user.keyboard('{Escape}');
    expect(ui.onClose).toHaveBeenCalledTimes(1);
    expect(ui.keys).toEqual([]);
    expect(ui.values()).toBe(design.id);
    expect(ui.search()).toHaveValue('Res');
    expect(calls).toHaveLength(0);
  });

  it('keeps search and draft after a 403 and claims no tag', async () => {
    const { calls } = installFakeApi({ [`POST ${tagsPath}`]: () => failure(403, 'FORBIDDEN', 'Not allowed') });
    const ui = setup();
    await ui.user.click(screen.getByRole('checkbox', { name: 'Design' }));
    await ui.user.type(ui.search(), 'Research');
    await ui.user.keyboard('{Enter}');
    await waitFor(() => expect(within(ui.recovery()).getByText('Tag “Research” from “Draft A” was not created.')).toBeInTheDocument());
    expect(calls).toHaveLength(1);
    expect(ui.search()).toHaveValue('Research');
    expect(ui.values()).toBe(design.id);
    expect(screen.getByTestId('held')).toHaveTextContent('false');
    expect(screen.queryByRole('checkbox', { name: 'Research' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry creating tag' })).not.toBeInTheDocument();
    expect(screen.queryByText(/was created in the workspace/)).not.toBeInTheDocument();
    await ui.user.click(within(screen.getByRole('form', { name: 'Draft row' })).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('status', { name: 'Inline tag creation' })).not.toBeInTheDocument();
    expect(ui.search()).toHaveValue('Research');
    expect(calls).toHaveLength(1);
  });

  it('does not attach a tag confirmed after tag rights were lost', async () => {
    const reply = deferred<Response>();
    const { calls } = installFakeApi({ [`POST ${tagsPath}`]: () => reply.promise });
    const ui = setup();
    await ui.user.type(ui.search(), 'Research');
    await ui.user.keyboard('{Enter}');
    await waitFor(() => expect(calls).toHaveLength(1));
    await ui.user.click(screen.getByRole('button', { name: 'Revoke tag rights' }));
    await act(async () => reply.resolve(created(research)));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Research' })).not.toBeChecked());
    expect(ui.values()).toBe('');
    await ui.user.type(ui.search(), 'Other');
    expect(screen.queryByRole('button', { name: 'Create tag “Other”' })).not.toBeInTheDocument();
    await ui.user.keyboard('{Enter}');
    expect(calls).toHaveLength(1);
  });

  it('refuses to retry an unknown create after tag rights were lost', async () => {
    const { calls } = installFakeApi({ [`POST ${tagsPath}`]: () => failure(503, 'UNAVAILABLE', 'Try again') });
    const ui = setup();
    await ui.user.type(ui.search(), 'Research');
    await ui.user.keyboard('{Enter}');
    const form = screen.getByRole('form', { name: 'Draft row' });
    await within(form).findByRole('button', { name: 'Retry creating tag' });
    await ui.user.click(screen.getByRole('button', { name: 'Revoke tag rights' }));
    const retries = screen.getAllByRole('button', { name: 'Retry creating tag' });
    expect(retries).toHaveLength(2);
    for (const retry of retries) {
      expect(retry).toHaveAttribute('aria-disabled', 'true');
      await ui.user.click(retry);
    }
    expect(calls).toHaveLength(1);
    expect(screen.getByTestId('held')).toHaveTextContent('true');
  });

  it('keeps the details dialog from retrying or adopting an inline create', async () => {
    const reply = deferred<Response>();
    const { calls } = installFakeApi({ [`POST ${tagsPath}`]: () => reply.promise });
    const ui = setup({ details: true });
    await ui.user.type(ui.search(), 'Research');
    await ui.user.keyboard('{Enter}');
    await waitFor(() => expect(calls).toHaveLength(1));
    await ui.user.click(screen.getByRole('button', { name: 'New tag' }));
    const dialog = screen.getByRole('dialog', { name: 'New tag' });
    expect(within(dialog).getByRole('status')).toHaveTextContent('A tag created from a task row is still unresolved.');
    expect(within(dialog).queryByRole('textbox', { name: 'Tag name' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Retry submission' })).not.toBeInTheDocument();
    await act(async () => reply.resolve(created(research)));
    await waitFor(() => expect(ui.values()).toBe(research.id));
    expect(ui.onDetailsCreated).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it('treats an unknown details create as foreign and starts nothing inline', async () => {
    const { calls } = installFakeApi({ [`POST ${tagsPath}`]: () => failure(503, 'UNAVAILABLE', 'Try again') });
    const ui = setup({ details: true });
    await ui.user.click(screen.getByRole('button', { name: 'New tag' }));
    const dialog = screen.getByRole('dialog', { name: 'New tag' });
    await ui.user.type(within(dialog).getByRole('textbox', { name: 'Tag name' }), 'Planning');
    await ui.user.click(within(dialog).getByRole('button', { name: 'Create tag' }));
    expect(await within(dialog).findByRole('button', { name: 'Retry submission' })).toBeInTheDocument();
    expect(isInlineTagCreateCommand(calls[0]?.body)).toBe(false);
    await ui.user.click(within(dialog).getByRole('button', { name: 'Hide' }));
    await ui.user.type(ui.search(), 'Research');
    const create = screen.getByRole('button', { name: 'Create tag “Research”' });
    expect(create).toHaveAttribute('aria-disabled', 'true');
    await ui.user.click(create);
    await ui.user.keyboard('{Enter}');
    expect(screen.getByRole('alert')).toHaveTextContent('Another tag is still being created. Wait for it or resolve it first.');
    expect(screen.getByTestId('held')).toHaveTextContent('false');
    expect(tagPosts(calls)).toHaveLength(1);
    expect(calls[0]?.body).toEqual({ name: 'Planning', color: null });
  });

  it('offers no create to a member and still selects existing tags', async () => {
    const { calls } = installFakeApi({});
    const ui = setup({ canCreate: false });
    await ui.user.type(ui.search(), 'Research');
    expect(screen.queryByRole('button', { name: /Create tag/ })).not.toBeInTheDocument();
    await ui.user.keyboard('{Enter}');
    await ui.user.clear(ui.search());
    await ui.user.click(screen.getByRole('checkbox', { name: 'Design' }));
    expect(ui.values()).toBe(design.id);
    expect(calls).toHaveLength(0);
  });

  it('starts nothing for a read-only owner, and refuses it as read-only rather than busy', async () => {
    const { calls } = installFakeApi({});
    const ui = setup({ canAttach: false });
    await ui.user.type(ui.search(), 'Research');
    const create = screen.getByRole('button', { name: 'Create tag “Research”' });
    expect(create).toBeVisible();
    expect(create).toHaveAttribute('aria-disabled', 'true');
    await ui.user.keyboard('{Enter}');
    await ui.user.click(create);
    expect(tagPosts(calls)).toHaveLength(0);
    expect(ui.onSubmit).not.toHaveBeenCalled();
    expect(ui.values()).toBe('');
    expect(screen.getByTestId('held')).toHaveTextContent('false');
    expect(screen.queryByText('Another tag is still being created. Wait for it or resolve it first.')).not.toBeInTheDocument();
    const controller: InlineTagController = ui.commands().inlineTags;
    expect(controller.canCreate()).toBe(true);
    expect(controller.busyFor('create:row-a')).toBe(false);
    expect(controller.current()).toBeNull();
    const origin: InlineTagOrigin = { id: 'create:readonly', taskId: null, label: 'Read-only' };
    const target: { current: LeaseTarget } = { current: { originId: origin.id, canAttach: false, onSelect: vi.fn(), onAttached: vi.fn() } };
    const { lease, release } = controller.lease(origin.id, target);
    try {
      const result: InlineTagStartResult = controller.start(origin, 'Research', [], lease);
      expect(result).toBe('readonly');
      expect(controller.current()).toBeNull();
      expect(tagPosts(calls)).toHaveLength(0);
    } finally {
      release();
    }
  });

  it.each([[' DESIGN ', 'A tag with this name already exists. Select it in the list.'], ['old TAG', 'An archived tag already uses this name. Restore it in workspace tags or choose another name.']])(
    'refuses a case-folded namesake %s, archived ones included, without toggling it', async (typed, notice) => {
      const { calls } = installFakeApi({});
      const ui = setup();
      await ui.user.type(ui.search(), typed);
      expect(screen.queryByRole('button', { name: /Create tag/ })).not.toBeInTheDocument();
      await ui.user.keyboard('{Enter}');
      expect(screen.getByRole('alert')).toHaveTextContent(notice);
      expect(ui.values()).toBe('');
      expect(ui.onSubmit).not.toHaveBeenCalled();
      expect(calls).toHaveLength(0);
    });
});
