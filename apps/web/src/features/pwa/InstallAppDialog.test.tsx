import { act, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { installManager, type InstallPromptEvent } from './install';
import { anna, ok, installFakeApi, renderApp, singleActorRoutes } from '../../test/fakeApi';
it('opens installation help from the account menu without sending a write or changing the route', async () => {
  const api = installFakeApi({ ...singleActorRoutes(anna, []), 'GET /api/v1/me': () => ok({ actor: anna, authMode: 'shared' }) }); const ui = renderApp('/');
  await ui.user.click(await screen.findByRole('button', { name: `User menu for ${anna.displayName}` }));
  await ui.user.click(screen.getByRole('menuitem', { name: 'Install Workloom' }));
  expect(await screen.findByRole('dialog', { name: 'Install Workloom' })).toBeVisible();
  expect(screen.getByText(/On iPhone or iPad/)).toBeVisible();
  expect(screen.getByText(/On desktop or Android/)).toBeVisible();
  expect(api.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  await ui.user.click(screen.getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('opens the native installer only from the install button and handles cancellation', async () => {
  installFakeApi({ ...singleActorRoutes(anna, []), 'GET /api/v1/me': () => ok({ actor: anna, authMode: 'shared' }) });
  const stop = installManager.start();
  try {
    const ui = renderApp('/');
    const event = new Event('beforeinstallprompt', { cancelable: true }) as InstallPromptEvent;
    event.prompt = vi.fn(async () => {}); event.userChoice = Promise.resolve({ outcome: 'dismissed' });
    act(() => { window.dispatchEvent(event); });
    await ui.user.click(await screen.findByRole('button', { name: `User menu for ${anna.displayName}` }));
    await ui.user.click(screen.getByRole('menuitem', { name: 'Install Workloom' }));
    expect(event.prompt).not.toHaveBeenCalled();
    await ui.user.click(screen.getByRole('button', { name: 'Install app' }));
    await waitFor(() => expect(event.prompt).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Install from your browser')).toBeVisible();
  } finally { stop(); }
});
