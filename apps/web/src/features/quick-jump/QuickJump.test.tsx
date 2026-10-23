import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { alpha, alphaMembers, anna, installFakeApi, json, renderApp, singleActorRoutes } from '../../test/fakeApi';

const path = `/api/v1/workspaces/${alpha.id}/my-tasks`;
const empty = () => json(200, { data: [], meta: { requestId: 'quick-jump', nextCursor: null } });

describe('quick jump', () => {
  it('opens with Ctrl+K, filters pages as you type and navigates with Enter', async () => {
    const { calls } = installFakeApi({ ...singleActorRoutes(anna, [alpha], { [alpha.id]: alphaMembers }), [`GET ${path}`]: empty });
    const { user } = renderApp(`/w/${alpha.id}`);
    await screen.findByRole('button', { name: 'Search and jump' });
    // The Overview itself reads the person's tasks; opening the palette must not add a request.
    const before = calls.filter(call => call.path === path && call.searchParams.has('search')).length;
    await user.keyboard('{Control>}k{/Control}');
    const input = await screen.findByRole('combobox', { name: 'Search' });
    expect(input).toHaveFocus();
    // Nothing is searched on the server until two characters are typed.
    expect(calls.filter(call => call.path === path && call.searchParams.has('search')).length).toBe(before);
    await user.type(input, 'time');
    const list = screen.getByRole('listbox', { name: 'Results' });
    expect(within(list).getAllByRole('option').map(option => option.textContent)).toEqual(['Time offPage']);
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.queryByRole('combobox', { name: 'Search' })).not.toBeInTheDocument());
    // The sidebar marks the page that is now open.
    await waitFor(() => expect(screen.getAllByRole('link', { name: /Time off/ }).some(link => link.getAttribute('aria-current') === 'page')).toBe(true));
  });

  it('says so when nothing matches', async () => {
    installFakeApi({ ...singleActorRoutes(anna, [alpha], { [alpha.id]: alphaMembers }), [`GET ${path}`]: empty });
    const { user } = renderApp(`/w/${alpha.id}`);
    await user.click(await screen.findByRole('button', { name: 'Search and jump' }));
    await user.type(await screen.findByRole('combobox', { name: 'Search' }), 'zzzzzz');
    expect(await screen.findByText('Nothing found.')).toBeInTheDocument();
  });
});
