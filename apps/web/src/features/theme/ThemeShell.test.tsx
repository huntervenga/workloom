import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { alpha, anna, deferred, failure, installFakeApi, ok, renderApp, singleActorRoutes } from '../../test/fakeApi';
import { queryKeys } from '../../lib/queryKeys';
import { themeManager } from './ThemeManager';
const settings = { userId: anna.id, revision: 2, settings: { version: 1, theme: 'dark' }, updatedAt: '2026-10-26T10:00:00.000Z' };
afterEach(() => themeManager.setTheme('default'));

describe('account theme at startup', () => {
  it('has no toggle while loading and applies settings from /me without an extra request', async () => {
    const pending = deferred<Response>();
    const { calls } = installFakeApi({ ...singleActorRoutes(anna, [alpha]), 'GET /api/v1/me': () => pending.promise });
    localStorage.setItem('workloom.theme', 'light');
    renderApp('/');
    expect(screen.queryByRole('button', { name: 'Dark theme' })).not.toBeInTheDocument();
    await act(async () => pending.resolve(ok({ actor: anna, authMode: 'dev', settings })));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'));
    expect(screen.queryByRole('button', { name: 'Dark theme' })).not.toBeInTheDocument();
    expect(calls.filter(call => call.path.endsWith('/me/settings') || call.method !== 'GET')).toEqual([]);
    expect(localStorage.getItem('workloom.theme')).toBe('light');
  });
  it('resets the prior account theme on an expired session and applies recovered settings', async () => {
    let answer = () => ok({ actor: anna, authMode: 'shared', settings });
    installFakeApi({ ...singleActorRoutes(anna, [alpha]), 'GET /api/v1/me': () => answer(), 'GET /api/v1/auth/config': () => ok({ authMode: 'shared' }) });
    const { queryClient } = renderApp('/');
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'));
    answer = () => failure(401, 'UNAUTHENTICATED', 'Expired');
    await act(async () => { await queryClient.invalidateQueries({ queryKey: queryKeys.me }); });
    await waitFor(() => expect(themeManager.getChoice()).toBe('default'));
    answer = () => ok({ actor: anna, authMode: 'shared', settings: { ...settings, revision: 3, settings: { version: 1, theme: 'light' } } });
    await act(async () => { await queryClient.invalidateQueries({ queryKey: queryKeys.me }); });
    await waitFor(() => expect(themeManager.getChoice()).toBe('light'));
  });
});
