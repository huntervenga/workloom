import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppRoutes } from '../../app/AppRoutes';
import { ProtectedNavigationGuard } from '../../app/ProtectedNavigationGuard';
import { SessionProvider } from '../../app/session';
import { createQueryClient } from '../../lib/queryClient';
import { alpha, anna, installFakeApi } from '../../test/fakeApi';
import { tablePath, tableRoutes } from '../work-categories/test/fixtures';
import { CHANGELOG, changelogMarker, newDays, type Changelog } from './changelog';

beforeAll(async () => { await import('../../routes/ProjectPage'); });

const cleanups: (() => void)[] = [];
beforeEach(() => window.localStorage.clear());
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); window.localStorage.clear(); });

function app(url: string) {
  installFakeApi(tableRoutes());
  const client = createQueryClient({ retry: false });
  const router = createMemoryRouter([{ path: '*', element: <SessionProvider><ProtectedNavigationGuard /><AppRoutes /></SessionProvider> }], { initialEntries: [url] });
  const view = render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  cleanups.push(() => { view.unmount(); router.dispose(); client.clear(); });
  return { router, user: userEvent.setup({ pointerEventsCheck: 0 }) };
}
const sidebar = async () => within(await screen.findByRole('complementary', { name: 'Sidebar' }));
const whatsNewLink = async () => (await sidebar()).getByRole('link', { name: /What's new/ });
function must<T>(value: T | null | undefined): T { if (value === null || value === undefined) throw new Error('missing'); return value; }
const newest = must(CHANGELOG.days[0]);

describe('What\'s new log data', () => {
  it('keeps days newest first with unique calendar dates, plain items and a full covered commit', () => {
    expect(CHANGELOG.covers).toMatch(/^[0-9a-f]{40}$/);
    expect(CHANGELOG.days.length).toBeGreaterThan(0);
    const dates = CHANGELOG.days.map(day => day.date);
    for (const date of dates) expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect([...dates].sort().reverse()).toEqual(dates);
    expect(new Set(dates).size).toBe(dates.length);
    for (const day of CHANGELOG.days) {
      expect(day.items.length).toBeGreaterThan(0);
      for (const item of day.items) expect(item.trim()).toBe(item);
      expect(new Set(day.items).size).toBe(day.items.length);
    }
  });

  it('counts a later day or more items on the newest day as new, and only the newest day on a first visit', () => {
    const log: Changelog = { covers: CHANGELOG.covers, days: [
      { date: '2026-11-12', items: ['a', 'b'] }, { date: '2026-11-10', items: ['c'] }, { date: '2026-11-01', items: ['d'] },
    ] };
    expect(changelogMarker(log)).toBe('2026-11-12:2');
    expect(newDays(log, '2026-11-12:2')).toEqual([]);
    expect(newDays(log, '2026-11-12:1').map(day => day.date)).toEqual(['2026-11-12']);
    expect(newDays(log, '2026-11-01:1').map(day => day.date)).toEqual(['2026-11-12', '2026-11-10']);
    expect(newDays(log, null).map(day => day.date)).toEqual(['2026-11-12']);
  });
});

describe('What\'s new in the shell', () => {
  it('offers the log in a corner note; Not now hides the note but keeps the sidebar dot until the page is opened', async () => {
    const { user } = app(tablePath);
    const note = await screen.findByRole('region', { name: 'What\'s new in Workloom' });
    expect(within(note).getByText(must(newest.items[0]))).toBeInTheDocument();
    expect(within(await whatsNewLink()).getByLabelText('New changes')).toBeInTheDocument();

    await user.click(within(note).getByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'What\'s new in Workloom' })).not.toBeInTheDocument());
    expect(within(await whatsNewLink()).getByLabelText('New changes')).toBeInTheDocument();

    await user.click(await whatsNewLink());
    expect(await screen.findByRole('heading', { level: 1, name: 'What\'s new' })).toBeInTheDocument();
    await waitFor(() => expect(within(screen.getByRole('complementary', { name: 'Sidebar' })).getByRole('link', { name: /What's new/ })).not.toContainElement(screen.queryByLabelText('New changes')));
    expect(screen.queryByLabelText('New changes')).not.toBeInTheDocument();
    expect(window.localStorage.getItem(`workloom.whatsNew.seen.${anna.id}`)).toBe(changelogMarker());
  });

  it('opens the log from the note and lists every day newest first, marking what was new', async () => {
    const { user, router } = app(tablePath);
    const note = await screen.findByRole('region', { name: 'What\'s new in Workloom' });
    await user.click(within(note).getByRole('link', { name: 'See what\'s new' }));
    await screen.findByRole('heading', { level: 1, name: 'What\'s new' });
    expect(router.state.location.pathname).toBe(`/w/${alpha.id}/whats-new`);
    expect(screen.queryByRole('region', { name: 'What\'s new in Workloom' })).not.toBeInTheDocument();

    const days = screen.getAllByRole('heading', { level: 2 });
    expect(days).toHaveLength(CHANGELOG.days.length);
    expect(days[0]).toHaveTextContent('November 12, 2026');
    // A first visit marks only the newest day, so the page is not a wall of "New".
    expect(within(must(days[0])).getByText('New')).toBeInTheDocument();
    for (const day of days.slice(1)) expect(within(day).queryByText('New')).not.toBeInTheDocument();
    const launch = CHANGELOG.days.find(day => day.title)?.title;
    if (launch) expect(screen.getByRole('heading', { level: 2, name: new RegExp(launch) })).toBeInTheDocument();
    const first = must(must(days[0]).closest('section'));
    expect(within(first).getAllByRole('listitem').map(item => item.textContent)).toEqual([...newest.items]);
  });

  it('shows nothing new once the newest entry has been seen', async () => {
    window.localStorage.setItem(`workloom.whatsNew.seen.${anna.id}`, must(changelogMarker()));
    app(tablePath);
    await whatsNewLink();
    expect(screen.queryByLabelText('New changes')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'What\'s new in Workloom' })).not.toBeInTheDocument();
  });
});
