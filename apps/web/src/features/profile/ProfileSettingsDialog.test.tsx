import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { alpha, anna, deferred, failure, installFakeApi, ok, renderApp, singleActorRoutes } from '../../test/fakeApi';
import { themeManager } from '../theme/ThemeManager';
import type { UserSettingsDto } from '@workloom/contracts';
import { queryKeys } from '../../lib/queryKeys';
const initial: UserSettingsDto = { userId: anna.id, revision: 0, settings: { version: 1, theme: 'default' }, updatedAt: null };
afterEach(() => themeManager.setTheme('default'));
function harness(write?: () => Response | Promise<Response>) {
  let settings = initial;
  let currentActor = anna;
  const api = installFakeApi({ ...singleActorRoutes(anna, [alpha]),
    'GET /api/v1/me': () => ok({ actor: currentActor, authMode: 'shared', settings }),
    'GET /api/v1/me/settings': () => ok(settings),
    'PATCH /api/v1/me/settings': ({ body }) => {
      if (write) return write();
      const input = body as { expectedRevision: number; expectedUserId: string; settings: { theme: UserSettingsDto['settings']['theme'] } };
      expect(input.expectedUserId).toBe(anna.id); expect(input.expectedRevision).toBe(settings.revision);
      settings = { ...settings, revision: settings.revision + 1, settings: { version: 1, ...input.settings }, updatedAt: '2026-10-26T10:00:00.000Z' };
      return ok(settings);
    },
  });
  return { ...api, ...renderApp('/'), saved: () => settings, changeActor: (actor: typeof anna) => { currentActor = actor; settings = { ...initial, userId: actor.id, settings: { version: 1, theme: 'light' } }; }, replace: (next: UserSettingsDto) => { settings = next; } };
}
async function open(ui: ReturnType<typeof harness>) {
  await ui.user.click(await screen.findByRole('button', { name: `User menu for ${anna.displayName}` }));
  await ui.user.click(await screen.findByRole('menuitem', { name: 'Settings' }));
  await screen.findByRole('dialog', { name: 'Settings' });
}
describe('profile theme settings', () => {
  it('opens from the user menu, saves automatically, restores after reopening, and uses no local theme storage', async () => {
    const ui = harness(); await open(ui);
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    await ui.user.click(screen.getByRole('radio', { name: /^Dark / }));
    await screen.findByText('Settings saved to your account.');
    expect(ui.saved().settings.theme).toBe('dark'); expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('workloom.theme')).toBeNull();
    await ui.user.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.getByRole('button', { name: `User menu for ${anna.displayName}` })).toHaveFocus());
    await open(ui); expect(screen.getByRole('radio', { name: /^Dark / })).toBeChecked();
    await ui.user.click(screen.getByRole('radio', { name: /^Light / }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'));
    expect(ui.calls.filter(call => call.method === 'PATCH')).toHaveLength(2);
  });
  it('keeps the confirmed theme on a failed save, then reloads a committed result without repeating the write', async () => {
    const ui = harness(() => failure(503, 'TEMPORARILY_UNAVAILABLE', 'Unknown outcome')); await open(ui);
    await ui.user.click(screen.getByRole('radio', { name: /^Dark / }));
    await screen.findByRole('alert'); expect(themeManager.getChoice()).toBe('default');
    ui.replace({ ...initial, revision: 1, settings: { version: 1, theme: 'dark' } });
    await ui.user.click(screen.getByRole('button', { name: 'Reload settings' }));
    await waitFor(() => expect(themeManager.getChoice()).toBe('dark'));
    expect(ui.calls.filter(call => call.method === 'PATCH')).toHaveLength(1);
  });
  it('does not apply an old actor’s late save to a different signed-in account', async () => {
    const pending = deferred<Response>(); const ui = harness(() => pending.promise); await open(ui);
    await ui.user.click(screen.getByRole('radio', { name: /^Dark / }));
    const other = { ...anna, id: 'ab000000-0000-4000-8000-000000000002', displayName: 'Other user' };
    await waitFor(() => expect(ui.calls.some(call => call.method === 'PATCH')).toBe(true));
    ui.changeActor(other);
    act(() => ui.queryClient.setQueryData(queryKeys.me, { actor: other, authMode: 'shared', settings: { ...initial, userId: other.id, settings: { version: 1, theme: 'light' } } }));
    await act(async () => pending.resolve(ok({ ...initial, revision: 1, settings: { version: 1, theme: 'dark' } })));
    await waitFor(() => expect(themeManager.getChoice()).toBe('light'));
  });
});
