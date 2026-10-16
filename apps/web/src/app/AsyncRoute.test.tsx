import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ComponentType } from 'react';
import { createMemoryRouter, Link, Outlet, RouterProvider, useSearchParams } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../lib/queryClient';
import { useProtectedDraft } from '../lib/protectedDrafts';
import { deferred } from '../test/fakeApi';
import { createAsyncRoute } from './AsyncRoute';
import { ProtectedNavigationGuard } from './ProtectedNavigationGuard';
import { protectedCommandsFor } from '../lib/protectedCommands';
import * as recovery from './routeRecovery';

describe('isolated asynchronous routes', () => {
  beforeEach(() => {
    vi.spyOn(recovery, 'probeAppUpdate').mockResolvedValue('unknown');
    vi.spyOn(recovery, 'reloadCurrentTab').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('offers explicit refresh for a confirmed update without reloading, retrying or changing the URL itself', async () => {
    vi.mocked(recovery.probeAppUpdate).mockResolvedValue('updated');
    const load = vi.fn().mockRejectedValue(new Error('private chunk URL or server detail'));
    const Page = createAsyncRoute(load, 'shell.loadingWeek');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const user = userEvent.setup();
    const href = window.location.href;
    try {
      render(<Page />);
      expect(await screen.findByRole('heading', { name: 'Workloom has been updated' })).toBeInTheDocument();
      expect(screen.getByRole('alert')).toHaveTextContent('Your current page address will be kept.');
      expect(screen.getByRole('button', { name: 'Refresh tab' })).toBeInTheDocument();
      expect(document.body).not.toHaveTextContent(/private chunk|unsaved|unconfirmed/i);
      expect(load).toHaveBeenCalledTimes(1);
      expect(recovery.reloadCurrentTab).not.toHaveBeenCalled();
      expect(window.location.href).toBe(href);
      await user.click(screen.getByRole('button', { name: 'Refresh tab' }));
      expect(recovery.reloadCurrentTab).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(load).toHaveBeenCalledTimes(1);
      expect(window.location.href).toBe(href);
    } finally { errors.mockRestore(); }
  });

  it('keeps the focused recovery action mounted while the version check completes', async () => {
    const check = deferred<recovery.AppUpdate>();
    vi.mocked(recovery.probeAppUpdate).mockReturnValue(check.promise);
    const Page = createAsyncRoute(async () => { throw new Error(); }, 'shell.loadingWeek');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      render(<Page />);
      await screen.findByRole('alert');
      const refresh = screen.getByRole('button', { name: 'Refresh tab' });
      refresh.focus();
      await act(async () => check.resolve('updated'));
      expect(screen.getByRole('button', { name: 'Refresh tab' })).toBe(refresh);
      expect(refresh).toHaveFocus();
      expect(recovery.reloadCurrentTab).not.toHaveBeenCalled();
    } finally { errors.mockRestore(); }
  });

  it('keeps an unverified import failure generic and does not expose its error', async () => {
    const Page = createAsyncRoute(async () => { throw new Error('private error'); }, 'shell.loadingWeek');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      render(<Page />);
      expect(await screen.findByRole('alert')).toHaveTextContent('The page files could not be loaded.');
      expect(screen.queryByRole('heading', { name: 'Workloom has been updated' })).not.toBeInTheDocument();
      expect(document.body).not.toHaveTextContent('private error');
      expect(recovery.reloadCurrentTab).not.toHaveBeenCalled();
    } finally { errors.mockRestore(); }
  });

  it('does not diagnose a component render error as a changed build', async () => {
    function BrokenPage() { throw new Error('private render detail'); return null; }
    const Page = createAsyncRoute(async () => ({ default: BrokenPage }), 'shell.loadingWeek');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      render(<Page />);
      expect(await screen.findByRole('alert')).toHaveTextContent('Unable to open this page');
      expect(recovery.probeAppUpdate).not.toHaveBeenCalled();
      expect(document.body).not.toHaveTextContent(/private render|page files could not/i);
    } finally { errors.mockRestore(); }
  });

  it('cancels an outstanding version check when retry begins and ignores its late result', async () => {
    const check = deferred<recovery.AppUpdate>();
    vi.mocked(recovery.probeAppUpdate).mockReturnValue(check.promise);
    const next = deferred<{ default: ComponentType }>();
    const load = vi.fn().mockRejectedValueOnce(new Error()).mockImplementationOnce(() => next.promise);
    const Page = createAsyncRoute(load, 'shell.loadingWeek');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const user = userEvent.setup();
    try {
      render(<Page />);
      await screen.findByRole('alert');
      const oldSignal = vi.mocked(recovery.probeAppUpdate).mock.calls[0]?.[2];
      await user.click(screen.getByRole('button', { name: 'Try loading page again' }));
      expect(oldSignal?.aborted).toBe(true);
      await act(async () => check.resolve('updated'));
      expect(screen.queryByRole('heading', { name: 'Workloom has been updated' })).not.toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent('Loading week');
      await act(async () => next.resolve({ default: () => <h1>Ready</h1> }));
      expect(await screen.findByRole('heading', { name: 'Ready' })).toBeInTheDocument();
      expect(recovery.reloadCurrentTab).not.toHaveBeenCalled();
    } finally { errors.mockRestore(); }
  });

  it.each(['draft', 'command'] as const)('keeps the existing native reload guard for actual retained %s state', async kind => {
    const Page = createAsyncRoute(async () => { throw new Error(); }, 'shell.loadingWeek');
    const client = createQueryClient({ retry: false });
    const command = protectedCommandsFor(client).register();
    function RetainedDraft() { useProtectedDraft(kind === 'draft'); return null; }
    const router = createMemoryRouter([{ path: '*', element: <><ProtectedNavigationGuard /><RetainedDraft /><Page /></> }]);
    const view = render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      if (kind === 'command') act(() => command.set(true));
      await screen.findByRole('alert');
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(recovery.reloadCurrentTab).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    } finally { command.dispose(); view.unmount(); router.dispose(); client.clear(); errors.mockRestore(); }
  });

  it('shows a loading status, catches a failed chunk and retries only on explicit action', async () => {
    let rejectFirst: (error: Error) => void = () => undefined;
    const first = new Promise<{ default: ComponentType }>((_resolve, reject) => { rejectFirst = reject; });
    const second = deferred<{ default: ComponentType }>();
    const load = vi.fn().mockImplementationOnce(() => first).mockImplementationOnce(() => second.promise);
    const Page = createAsyncRoute(load, 'shell.loadingProject');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const user = userEvent.setup();
    try {
      render(<Page />);
      expect(screen.getByRole('status')).toHaveTextContent('Loading project');
      await act(async () => rejectFirst(new Error('Chunk unavailable')));
      expect(await screen.findByRole('alert')).toHaveTextContent("Unable to open this page");
      expect(load).toHaveBeenCalledTimes(1);
      await user.click(screen.getByRole('button', { name: "Try loading page again" }));
      expect(load).toHaveBeenCalledTimes(2);
      expect(screen.getByRole('status')).toHaveTextContent('Loading project');
      await act(async () => second.resolve({ default: () => <h1>Страница загружена</h1> }));
      expect(await screen.findByRole('heading', { name: 'Страница загружена' })).toBeInTheDocument();
      expect(load).toHaveBeenCalledTimes(2);
    } finally { errors.mockRestore(); }
  });

  it('preserves a typed draft on query changes and blocked departures before loading the next route', async () => {
    function DraftPage() {
      const [value, setValue] = useState('');
      const [, setParams] = useSearchParams();
      useProtectedDraft(value !== '');
      return <><label>Черновик<input value={value} onChange={event => setValue(event.target.value)} /></label><button onClick={() => setParams({ view: 'other' })}>Другое представление</button><Link to="/next">Другая страница</Link></>;
    }
    const Draft = createAsyncRoute(async () => ({ default: DraftPage }), 'shell.loadingProject');
    const next = deferred<{ default: ComponentType }>(); const loadNext = vi.fn(() => next.promise);
    const Next = createAsyncRoute(loadNext, 'shell.loadingWeek');
    const client = createQueryClient({ retry: false });
    const router = createMemoryRouter([{ element: <><ProtectedNavigationGuard /><Outlet /></>, children: [{ path: '/', element: <Draft /> }, { path: '/next', element: <Next /> }] }]);
    const view = render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    try {
      await user.type(await screen.findByRole('textbox', { name: 'Черновик' }), 'Сохранить мои даты и часы');
      await user.click(screen.getByRole('button', { name: 'Другое представление' }));
      expect(router.state.location.search).toBe('?view=other');
      expect(screen.getByRole('textbox', { name: 'Черновик' })).toHaveValue('Сохранить мои даты и часы');
      await user.click(screen.getByRole('link', { name: 'Другая страница' }));
      const dialog = await screen.findByRole('dialog', { name: "Leave this page?" });
      expect(dialog).toHaveTextContent("You have an unsaved draft on this page.");
      expect(loadNext).not.toHaveBeenCalled();
      await user.click(within(dialog).getByRole('button', { name: "Stay" }));
      expect(screen.getByRole('textbox', { name: 'Черновик' })).toHaveValue('Сохранить мои даты и часы');
      await user.click(screen.getByRole('link', { name: 'Другая страница' }));
      await user.click(within(await screen.findByRole('dialog', { name: "Leave this page?" })).getByRole('button', { name: "Leave without saving" }));
      await waitFor(() => expect(loadNext).toHaveBeenCalledTimes(1));
      expect(screen.getByRole('status')).toHaveTextContent('Loading week');
      await act(async () => next.resolve({ default: () => <h1>Другая страница загружена</h1> }));
      expect(await screen.findByRole('heading', { name: 'Другая страница загружена' })).toBeInTheDocument();
    } finally { view.unmount(); router.dispose(); client.clear(); }
  });
});
