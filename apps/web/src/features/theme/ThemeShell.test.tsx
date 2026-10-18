import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import englishTheme from '../../i18n/locales/en/theme.json';
import { queryKeys } from '../../lib/queryKeys';
import { alpha, anna, deferred, failure, installFakeApi, ok, renderApp, singleActorRoutes, type RouteTable } from '../../test/fakeApi';
import { themeManager, THEME_STORAGE_KEY } from './ThemeManager';

/*
 * The real AppShell over the fake API: screens without a Topbar still offer the theme switch, and
 * once identity resolves the Topbar's switch is the only visible one. Identity transitions come
 * from the existing me query refetch; no sign-in is simulated.
 */

let stopTheme: (() => void) | null = null;

beforeEach(() => {
  // main.tsx starts the singleton outside React; each test starts it from a clean slate.
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.style.colorScheme = '';
  stopTheme = themeManager.start();
});

afterEach(() => {
  cleanup();
  stopTheme?.();
  stopTheme = null;
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.style.colorScheme = '';
});

const visibleToggles = () => screen.queryAllByRole('button', { name: englishTheme.label });

/** Routes whose identity answer the test swaps between phases. */
function shellRoutes(firstMe: () => Response | Promise<Response>) {
  let me = firstMe;
  const routes: RouteTable = {
    ...singleActorRoutes(anna, [alpha]),
    'GET /api/v1/me': () => me(),
    'GET /api/v1/auth/config': () => ok({ authMode: 'shared' }),
  };
  return { routes, answerMe: (next: () => Response | Promise<Response>) => { me = next; } };
}

/** The one visible toggle, outside any Topbar, still showing the light theme. */
function publicToggle() {
  const [button, ...others] = visibleToggles();
  expect(others).toHaveLength(0);
  if (!button) throw new Error('Expected the public theme button');
  expect(button.closest('header')).toBeNull();
  expect(button.getAttribute('aria-pressed')).toBe('false');
  return button;
}

function expectDarkChoice() {
  expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  expect(themeManager.getChoice()).toBe('dark');
}

async function expectSoleTopbarToggle() {
  await waitFor(() => {
    const toggles = visibleToggles();
    expect(toggles).toHaveLength(1);
    expect(toggles[0]?.closest('header')).not.toBeNull();
  });
  const [toggle] = visibleToggles();
  expect(toggle?.getAttribute('aria-pressed')).toBe('true');
  expectDarkChoice();
  return toggle;
}

const onlyReads = (calls: { method: string }[]) => expect(calls.filter(call => call.method !== 'GET')).toEqual([]);

describe('theme switch outside the Topbar', () => {
  it('is offered while identity is pending and hands over to the Topbar once it resolves', async () => {
    const pending = deferred<Response>();
    const { routes } = shellRoutes(() => pending.promise);
    const { calls } = installFakeApi(routes);
    const { user } = renderApp('/');

    await screen.findByRole('button', { name: englishTheme.label });
    expect(screen.queryAllByRole('status').length).toBeGreaterThan(0);
    const button = publicToggle();
    await user.click(button);
    expectDarkChoice();
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(button);
    expect(visibleToggles()).toEqual([button]);

    pending.resolve(ok({ actor: anna, authMode: 'dev' }));
    await expectSoleTopbarToggle();
    onlyReads(calls);
  });

  it('is offered on the sign-in screen for a guest and keeps the choice after identity is read again', async () => {
    const { routes, answerMe } = shellRoutes(() => failure(401, 'UNAUTHENTICATED', 'No session'));
    const { calls } = installFakeApi(routes);
    const { user, queryClient } = renderApp('/');

    await screen.findByRole('heading', { level: 1 });
    const button = publicToggle();
    await user.click(button);
    expectDarkChoice();
    expect(document.activeElement).toBe(button);
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();

    answerMe(() => ok({ actor: anna, authMode: 'dev' }));
    await queryClient.invalidateQueries({ queryKey: queryKeys.me });
    await expectSoleTopbarToggle();
    onlyReads(calls);
  });

  it('is offered beside an identity failure, keeping its content, and hands over after a retry', async () => {
    const { routes, answerMe } = shellRoutes(() => failure(500, 'INTERNAL', 'Broken'));
    const { calls } = installFakeApi(routes);
    const { user, queryClient } = renderApp('/');

    const heading = await screen.findByRole('heading', { level: 1 });
    const button = publicToggle();
    expect(heading.contains(button)).toBe(false);
    await user.click(button);
    expectDarkChoice();
    expect(document.activeElement).toBe(button);
    expect(screen.getByRole('heading', { level: 1 })).toBe(heading);

    answerMe(() => ok({ actor: anna, authMode: 'dev' }));
    await queryClient.invalidateQueries({ queryKey: queryKeys.me });
    await expectSoleTopbarToggle();
    onlyReads(calls);
  });

  it('covers an expired shared frame without remounting it, and the frame toggle is visible again after recovery', async () => {
    const { routes, answerMe } = shellRoutes(() => ok({ actor: anna, authMode: 'shared' }));
    const { calls } = installFakeApi(routes);
    const { user, queryClient } = renderApp('/');

    await waitFor(() => expect(visibleToggles()[0]?.closest('header')).not.toBeNull());
    const [frameToggle, ...extra] = visibleToggles();
    expect(extra).toHaveLength(0);

    answerMe(() => failure(401, 'UNAUTHENTICATED', 'Session expired'));
    await queryClient.invalidateQueries({ queryKey: queryKeys.me });
    await screen.findByRole('heading', { level: 1 });
    await waitFor(() => expect(visibleToggles()[0]?.closest('header')).toBeNull());
    const button = publicToggle();
    // The kept frame still holds its own toggle, hidden behind the gate.
    expect(screen.getAllByRole('button', { name: englishTheme.label, hidden: true })).toContain(frameToggle);

    await user.click(button);
    expectDarkChoice();
    expect(document.activeElement).toBe(button);
    expect(frameToggle?.getAttribute('aria-pressed')).toBe('true');

    answerMe(() => ok({ actor: anna, authMode: 'shared' }));
    await queryClient.invalidateQueries({ queryKey: queryKeys.me });
    expect(await expectSoleTopbarToggle()).toBe(frameToggle);
    onlyReads(calls);
  });
});
