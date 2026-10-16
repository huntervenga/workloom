import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ComponentType } from 'react';
import { createMemoryRouter, Link, Outlet, RouterProvider, useSearchParams } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../lib/queryClient';
import { useProtectedDraft } from '../lib/protectedDrafts';
import { deferred } from '../test/fakeApi';
import { createAsyncRoute } from './AsyncRoute';
import { ProtectedNavigationGuard } from './ProtectedNavigationGuard';

describe('isolated asynchronous routes', () => {
  it('shows a loading status, catches a failed chunk and retries only on explicit action', async () => {
    let rejectFirst: (error: Error) => void = () => undefined;
    const first = new Promise<{ default: ComponentType }>((_resolve, reject) => { rejectFirst = reject; });
    const second = deferred<{ default: ComponentType }>();
    const load = vi.fn().mockImplementationOnce(() => first).mockImplementationOnce(() => second.promise);
    const Page = createAsyncRoute(load, 'Загрузка тестовой страницы');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const user = userEvent.setup();
    try {
      render(<Page />);
      expect(screen.getByRole('status')).toHaveTextContent('Загрузка тестовой страницы');
      await act(async () => rejectFirst(new Error('Chunk unavailable')));
      expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось открыть страницу');
      expect(load).toHaveBeenCalledTimes(1);
      await user.click(screen.getByRole('button', { name: 'Повторить загрузку страницы' }));
      expect(load).toHaveBeenCalledTimes(2);
      expect(screen.getByRole('status')).toHaveTextContent('Загрузка тестовой страницы');
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
    const Draft = createAsyncRoute(async () => ({ default: DraftPage }), 'Загрузка черновика');
    const next = deferred<{ default: ComponentType }>(); const loadNext = vi.fn(() => next.promise);
    const Next = createAsyncRoute(loadNext, 'Загрузка другой страницы');
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
      const dialog = await screen.findByRole('dialog', { name: 'Уйти со страницы?' });
      expect(dialog).toHaveTextContent('На странице есть несохранённый черновик.');
      expect(loadNext).not.toHaveBeenCalled();
      await user.click(within(dialog).getByRole('button', { name: 'Остаться' }));
      expect(screen.getByRole('textbox', { name: 'Черновик' })).toHaveValue('Сохранить мои даты и часы');
      await user.click(screen.getByRole('link', { name: 'Другая страница' }));
      await user.click(within(await screen.findByRole('dialog', { name: 'Уйти со страницы?' })).getByRole('button', { name: 'Уйти без сохранения' }));
      await waitFor(() => expect(loadNext).toHaveBeenCalledTimes(1));
      expect(screen.getByRole('status')).toHaveTextContent('Загрузка другой страницы');
      await act(async () => next.resolve({ default: () => <h1>Другая страница загружена</h1> }));
      expect(await screen.findByRole('heading', { name: 'Другая страница загружена' })).toBeInTheDocument();
    } finally { view.unmount(); router.dispose(); client.clear(); }
  });
});
