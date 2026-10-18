import { QueryClientProvider } from '@tanstack/react-query';
import type { TagDto } from '@workloom/contracts';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { alpha, anna, deferred, failure, installFakeApi, ok } from '../../test/fakeApi';
import { renderFieldUi } from '../fields/test/fixtures';
import { TagManagerDialog } from './TagDialogs';
import { TagColorPalette } from './TagColorPalette';
import { TagBadge } from './TagBadge';
import { tagColor } from './tagColors';

const tag: TagDto = { id: 'f7000000-0000-4000-8000-000000000001', workspaceId: alpha.id, name: 'Design', color: null, revision: 7, archivedAt: null };
const path = `/api/v1/workspaces/${alpha.id}/tags`;
const dialog = () => screen.getByRole('dialog', { name: 'Workspace tags' });

it('uses one colored outlined badge in either theme and preserves a legacy null', () => {
  const ui = render(<div data-theme="dark"><TagBadge tag={tag} /></div>);
  const chip = screen.getByText('Design').closest('[data-tag-badge]');
  expect(chip).toHaveAttribute('data-tag-color', tagColor(tag));
  expect(chip).toHaveClass('text-ink', 'border');
  ui.rerender(<div data-theme="light"><TagBadge tag={tag} /></div>);
  expect(screen.getByText('Design').closest('[data-tag-badge]')).toHaveAttribute('data-tag-color', tagColor(tag));
  expect(tag.color).toBeNull();
});

it('supports native keyboard palette choice without submitting the enclosing form', async () => {
  const submit = vi.fn();
  function Example() { const [value, setValue] = useState<string | null>(null); return <form onSubmit={event => { event.preventDefault(); submit(); }}><TagColorPalette value={value} onChange={setValue} /><output>{value}</output></form>; }
  render(<Example />); const user = userEvent.setup();
  screen.getByRole('radio', { name: 'Blue' }).focus();
  await user.keyboard(' '); expect(screen.getByRole('radio', { name: 'Blue' })).toBeChecked();
  await user.keyboard('{Enter}'); expect(submit).not.toHaveBeenCalled();
});

describe('immediate persisted tag color', () => {
  it('keeps an unknown command through dialog collapse and retries the exact body/key once, without any task write', async () => {
    let tags = [tag], count = 0; const answer = deferred<Response>();
    const { calls } = installFakeApi({ [`GET ${path}`]: () => ok(tags), [`PATCH ${path}/${tag.id}`]: () => {
      count++; if (count === 1) return answer.promise;
      tags = [{ ...tag, color: '#ef4444', revision: 8 }]; return ok(tags[0]);
    } });
    const ui = renderFieldUi(<TagManagerDialog actorId={anna.id} workspaceId={alpha.id} canEdit />);
    await ui.user.click(screen.getByRole('button', { name: 'Tags' }));
    await ui.user.click(await within(dialog()).findByRole('button', { name: 'Color for Design' }));
    await ui.user.click(within(dialog()).getByRole('radio', { name: 'Red' }));
    await waitFor(() => expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(1));
    expect(within(dialog()).getByRole('radio', { name: 'Blue' })).toBeDisabled();
    expect(within(dialog()).getByRole('button', { name: 'Color for Design' })).toHaveFocus();
    await ui.user.click(within(dialog()).getByRole('button', { name: 'Close' }));
    await act(async () => answer.resolve(failure(503, 'UNAVAILABLE', 'Answer unavailable')));
    await ui.user.click(screen.getByRole('button', { name: 'Tags' }));
    const retry = await within(dialog()).findByRole('button', { name: 'Retry original color change' });
    await ui.user.click(retry);
    await waitFor(() => expect(within(dialog()).queryByRole('button', { name: 'Retry original color change' })).not.toBeInTheDocument());
    const writes = calls.filter(call => call.method !== 'GET');
    expect(writes).toHaveLength(2);
    expect(writes.map(call => call.body)).toEqual([{ expectedRevision: 7, color: '#ef4444' }, { expectedRevision: 7, color: '#ef4444' }]);
    expect(writes[0]?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/i);
    expect(writes[1]?.headers.get('Idempotency-Key')).toBe(writes[0]?.headers.get('Idempotency-Key'));
    expect(writes.every(call => call.path === `${path}/${tag.id}`)).toBe(true);
    expect(within(dialog()).getByRole('button', { name: 'Color for Design' })).toHaveFocus();
  });

  it('persists Automatic as null through one guarded PATCH, then renders the same stable fallback', async () => {
    let current: TagDto = { ...tag, color: '#ef4444' };
    const { calls } = installFakeApi({ [`GET ${path}`]: () => ok([current]), [`PATCH ${path}/${tag.id}`]: request => {
      const input = request.body as { expectedRevision: number; color: string | null };
      current = { ...current, color: input.color, revision: current.revision + 1 }; return ok(current);
    } });
    const ui = renderFieldUi(<TagManagerDialog actorId={anna.id} workspaceId={alpha.id} canEdit />);
    await ui.user.click(screen.getByRole('button', { name: 'Tags' }));
    await ui.user.click(await within(dialog()).findByRole('button', { name: 'Color for Design' }));
    await ui.user.click(within(dialog()).getByRole('button', { name: 'Automatic color' }));
    await waitFor(() => expect(within(dialog()).getByText('Design').closest('[data-tag-badge]')).toHaveAttribute('data-tag-color', tagColor(tag)));
    const writes = calls.filter(call => call.method !== 'GET'); expect(writes).toHaveLength(1);
    expect(writes[0]?.body).toEqual({ expectedRevision: tag.revision, color: null }); expect(current.color).toBeNull();
  });

  it('does not silently rebase a stale color or grant members a write', async () => {
    let current = tag; const { calls } = installFakeApi({ [`GET ${path}`]: () => ok([current]), [`PATCH ${path}/${tag.id}`]: () => failure(409, 'CONFLICT', 'Tag changed') });
    const ui = renderFieldUi(<TagManagerDialog actorId={anna.id} workspaceId={alpha.id} canEdit />);
    await ui.user.click(screen.getByRole('button', { name: 'Tags' }));
    await ui.user.click(await within(dialog()).findByRole('button', { name: 'Color for Design' }));
    await ui.user.click(within(dialog()).getByRole('radio', { name: 'Red' }));
    await within(dialog()).findByRole('button', { name: 'Reload tags' });
    expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(1);
    current = { ...tag, color: '#22c55e', revision: 8 };
    await ui.user.click(within(dialog()).getByRole('button', { name: 'Reload tags' }));
    await waitFor(() => expect(within(dialog()).queryByRole('button', { name: 'Reload tags' })).not.toBeInTheDocument());
    expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(1);
    ui.rerender(<QueryClientProvider client={ui.client}><TagManagerDialog actorId={anna.id} workspaceId={alpha.id} canEdit={false} /></QueryClientProvider>);
    await ui.user.click(within(dialog()).getByRole('button', { name: 'Color for Design' }));
    expect(within(dialog()).getByRole('radio', { name: 'Red' })).toBeDisabled();
    await ui.user.click(within(dialog()).getByRole('radio', { name: 'Red' }));
    expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(1);
  });
});
