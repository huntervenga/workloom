import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { uploadedAvatarUrl, type MeDto, type UserAvatarDto } from '@workloom/contracts';
import { queryKeys } from '../../lib/queryKeys';
import { anna, boris, deferred, failure, installFakeApi, ok } from '../../test/fakeApi';
import { AvatarSettings } from './AvatarSettings';

const photo = uploadedAvatarUrl(anna.id, '10000000-0000-4000-8000-000000000010');
const me: MeDto = { actor: anna, authMode: 'shared' };
function mount(options: { enabled?: boolean; custom?: boolean; write?: () => Response | Promise<Response> } = {}) {
  let state: UserAvatarDto = { userId: anna.id, revision: 0, avatarUrl: options.custom ? photo : null, hasCustomAvatar: options.custom ?? false };
  const enabled = options.enabled ?? true;
  const api = installFakeApi({
    'GET /api/v1/features': () => ok({ features: {
      taskAttachments: { enabled, reason: enabled ? null : 'storage_not_configured', limits: { maxFilesPerTask: 5, maxFileSizeBytes: 50_000_000 }, uploadMode: 'api-stream', downloadMode: 'signed-url', downloadUrlTtlSeconds: 3600 },
      userAvatars: { enabled, reason: enabled ? null : 'storage_not_configured', maxFileSizeBytes: 5_000_000, acceptedTypes: ['image/jpeg', 'image/png', 'image/webp'] },
    } }),
    'GET /api/v1/me/avatar': () => ok(state),
    'GET /api/v1/me': () => ok({ ...me, actor: { ...anna, avatarUrl: state.avatarUrl } }),
    'PUT /api/v1/me/avatar': request => {
      expect(request.headers.get('X-Workloom-Expected-Actor')).toBe(anna.id);
      expect(request.headers.get('X-Workloom-Avatar-Revision')).toBe(String(state.revision));
      expect(request.headers.get('Content-Type')).toBe('application/octet-stream');
      expect(request.credentials).toBe('same-origin');
      if (options.write) return options.write();
      state = { ...state, revision: state.revision + 1, hasCustomAvatar: true, avatarUrl: photo }; return ok(state);
    },
    'DELETE /api/v1/me/avatar': request => {
      expect(request.body).toEqual({ expectedUserId: anna.id, expectedRevision: state.revision });
      state = { ...state, revision: state.revision + 1, hasCustomAvatar: false, avatarUrl: null }; return ok(state);
    },
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(queryKeys.me, me);
  const invalidated = vi.spyOn(client, 'invalidateQueries');
  const view = render(<QueryClientProvider client={client}><AvatarSettings me={me} /></QueryClientProvider>);
  return { ...view, ...api, client, invalidated, user: userEvent.setup(), setState: (next: UserAvatarDto) => { state = next; } };
}
const file = () => new File(['synthetic image'], 'photo.png', { type: 'image/png' });
const choose = (value: File) => fireEvent.change(screen.getByLabelText('Choose profile photo'), { target: { files: [value] } });
const writes = (ui: ReturnType<typeof mount>) => ui.calls.filter(call => ['PUT', 'DELETE'].includes(call.method));

describe('profile avatar settings', () => {
  it('disables uploads and explains missing S3 configuration', async () => {
    const ui = mount({ enabled: false });
    expect(await screen.findByText('Configure S3 storage on the server to upload profile photos.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Upload photo' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Upload photo' }).parentElement).toHaveAttribute('title', 'Configure S3 storage on the server to upload profile photos.');
    choose(file()); expect(writes(ui)).toHaveLength(0);
  });
  it('uploads immediately, updates the shared profile and refreshes user projections', async () => {
    const ui = mount(); await waitFor(() => expect(screen.getByRole('button', { name: 'Upload photo' })).toBeEnabled());
    const selected = file(); choose(selected);
    await screen.findByText('Profile photo updated.');
    expect(ui.container.querySelector('img')).toHaveAttribute('src', photo);
    expect(ui.client.getQueryData<MeDto>(queryKeys.me)?.actor.avatarUrl).toBe(photo);
    expect(writes(ui)).toHaveLength(1);
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.body === selected)).toBe(true);
    expect(ui.invalidated).toHaveBeenCalledWith({ queryKey: queryKeys.actor(anna.id) });
    expect(screen.getByRole('button', { name: 'Change photo' })).toBeEnabled();
  });
  it('rejects unsupported files and the size limit before making an upload request', async () => {
    const ui = mount(); await waitFor(() => expect(screen.getByRole('button', { name: 'Upload photo' })).toBeEnabled());
    choose(new File(['<svg/>'], 'photo.svg', { type: 'image/svg+xml' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('JPEG, PNG or WebP');
    const large = file(); Object.defineProperty(large, 'size', { value: 5_000_001 }); choose(large);
    expect(screen.getByRole('alert')).toHaveTextContent('5 MB'); expect(writes(ui)).toHaveLength(0);
  });
  it('keeps the confirmed photo on failure and can recover a committed response through reload', async () => {
    const ui = mount({ write: () => failure(503, 'TEMPORARILY_UNAVAILABLE', 'Private storage error') });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Upload photo' })).toBeEnabled()); choose(file());
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be confirmed');
    expect(ui.container.querySelector('img')).toBeNull(); expect(screen.queryByText('Private storage error')).not.toBeInTheDocument();
    ui.setState({ userId: anna.id, revision: 1, hasCustomAvatar: true, avatarUrl: photo });
    await ui.user.click(screen.getByRole('button', { name: 'Reload profile photo' }));
    await waitFor(() => expect(ui.container.querySelector('img')).toHaveAttribute('src', photo));
    expect(writes(ui)).toHaveLength(1);
  });
  it('allows removing the custom photo even with S3 disabled', async () => {
    const ui = mount({ enabled: false, custom: true });
    await ui.user.click(await screen.findByRole('button', { name: 'Remove custom photo' }));
    await screen.findByText('Profile photo updated.'); expect(ui.container.querySelector('img')).toBeNull();
    expect(writes(ui).map(call => call.method)).toEqual(['DELETE']);
  });
  it('does not apply a late response to a different account', async () => {
    const held = deferred<Response>(), ui = mount({ write: () => held.promise });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Upload photo' })).toBeEnabled()); choose(file());
    await waitFor(() => expect(writes(ui)).toHaveLength(1));
    ui.client.setQueryData(queryKeys.me, { actor: boris, authMode: 'shared' });
    await act(async () => { held.resolve(ok({ userId: anna.id, revision: 1, avatarUrl: photo, hasCustomAvatar: true })); });
    expect(ui.client.getQueryData<MeDto>(queryKeys.me)?.actor).toEqual(boris);
    expect(ui.invalidated).not.toHaveBeenCalled();
  });
});
