import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { alpha, alphaMembers, anna, installFakeApi, json, renderApp, singleActorRoutes } from '../../test/fakeApi';

const path = `/api/v1/workspaces/${alpha.id}/my-tasks`;
const searchPath = `/api/v1/workspaces/${alpha.id}/task-search`;
const empty = () => json(200, { data: [], meta: { requestId: 'quick-jump', nextCursor: null } });

describe('quick jump', () => {
  it('opens with Ctrl+K, filters pages as you type and navigates with Enter', async () => {
    const { calls } = installFakeApi({ ...singleActorRoutes(anna, [alpha], { [alpha.id]: alphaMembers }), [`GET ${path}`]: empty, [`GET ${searchPath}`]: empty });
    const { user } = renderApp(`/w/${alpha.id}`);
    await screen.findByRole('button', { name: 'Search and jump' });
    // The Overview itself reads the person's tasks; opening the palette must not add a request.
    const before = calls.filter(call => call.path === searchPath).length;
    await user.keyboard('{Control>}k{/Control}');
    const input = await screen.findByRole('combobox', { name: 'Search' });
    expect(input).toHaveFocus();
    // Nothing is searched on the server until two characters are typed.
    expect(calls.filter(call => call.path === searchPath).length).toBe(before);
    await user.type(input, 'time');
    const list = screen.getByRole('listbox', { name: 'Results' });
    expect(within(list).getAllByRole('option').map(option => option.textContent)).toEqual(['Time offPage']);
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.queryByRole('combobox', { name: 'Search' })).not.toBeInTheDocument());
    // The sidebar marks the page that is now open.
    await waitFor(() => expect(screen.getAllByRole('link', { name: /Time off/ }).some(link => link.getAttribute('aria-current') === 'page')).toBe(true));
  });

  it('finds a finished workspace task with its project and status', async () => {
    const task = { id: 'a0000000-0000-4000-8000-000000000001', title: 'Launch checklist',
      projectId: 'a0000000-0000-4000-8000-000000000002', projectName: 'Release', statusName: 'Done', statusGroup: 'done' };
    const { calls } = installFakeApi({
      ...singleActorRoutes(anna, [alpha], { [alpha.id]: alphaMembers }),
      [`GET ${path}`]: empty,
      [`GET ${searchPath}`]: () => json(200, { data: [task], meta: { requestId: 'quick-jump' } }),
    });
    const { user } = renderApp(`/w/${alpha.id}`);
    await user.click(await screen.findByRole('button', { name: 'Search and jump' }));
    await user.type(screen.getByRole('combobox', { name: 'Search' }), 'launch');
    expect(await screen.findByRole('option', { name: /Launch checklist.*Release · Done/ })).toBeVisible();
    expect(calls.filter(call => call.path === searchPath).map(call => call.searchParams.get('q'))).toEqual(['launch']);
  });

  it('says so when nothing matches', async () => {
    installFakeApi({ ...singleActorRoutes(anna, [alpha], { [alpha.id]: alphaMembers }), [`GET ${path}`]: empty, [`GET ${searchPath}`]: empty });
    const { user } = renderApp(`/w/${alpha.id}`);
    await user.click(await screen.findByRole('button', { name: 'Search and jump' }));
    await user.type(await screen.findByRole('combobox', { name: 'Search' }), 'zzzzzz');
    expect(await screen.findByText('Nothing found.')).toBeInTheDocument();
  });
});
