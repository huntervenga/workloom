import { screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';
import { alpha, alphaMembers, anna, installFakeApi, ok } from '../../test/fakeApi';
import { renderFieldUi } from '../fields/test/fixtures';
import { overview, prefix } from '../time-off/test/fixtures';
import { checklistState, GettingStarted } from './GettingStarted';

describe('getting started checklist', () => {
  beforeEach(() => window.localStorage.clear());

  it('marks only what is known to be done and keeps unknown steps neutral', () => {
    expect(checklistState({ members: alphaMembers, projectCount: 2, timeOffConfigured: true, hasToken: false }).map(item => item.done)).toEqual([true, true, true, false]);
    expect(checklistState({ members: undefined, projectCount: undefined, timeOffConfigured: undefined, hasToken: undefined }).map(item => item.done)).toEqual([null, null, null, null]);
    expect(checklistState({ members: [alphaMembers[0] as (typeof alphaMembers)[number]], projectCount: 0, timeOffConfigured: false, hasToken: undefined }).map(item => item.done)).toEqual([false, false, false, null]);
  });

  it('shows progress, links each step, and stays hidden after it is dismissed', async () => {
    installFakeApi({
      [`GET ${prefix}/overview`]: () => ok({ ...overview(), settings: null }),
      'GET /api/v1/me/api-tokens': () => ok([]),
    });
    const ui = renderFieldUi(<MemoryRouter><GettingStarted actorId={anna.id} workspaceId={alpha.id} members={alphaMembers} projectCount={1} /></MemoryRouter>);
    expect(await screen.findByText('2 of 4 first steps done')).toBeInTheDocument();
    expect(document.querySelector('[data-step="project"]')?.getAttribute('data-done')).toBe('true');
    expect(document.querySelector('[data-step="timeOff"]')?.getAttribute('data-done')).toBe('false');
    expect(screen.getByRole('link', { name: /Set up working hours and time off/ }).getAttribute('href')).toContain('/time-off');
    await ui.user.click(screen.getByRole('button', { name: 'Hide the getting started list' }));
    expect(screen.queryByText('Getting started')).not.toBeInTheDocument();
  });

  it('disappears on its own when every step is done', async () => {
    installFakeApi({
      [`GET ${prefix}/overview`]: () => ok(overview()),
      'GET /api/v1/me/api-tokens': () => ok([{ id: 'a0000000-0000-4000-8000-000000000001', name: 'CI', tokenPrefix: 'wlm_pat_abcd', scopes: ['read'], workspaceIds: null, createdAt: '2026-10-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null, lastUsedAt: null }]),
    });
    const { container } = renderFieldUi(<MemoryRouter><GettingStarted actorId={anna.id} workspaceId={alpha.id} members={alphaMembers} projectCount={3} /></MemoryRouter>);
    await screen.findByText(/first steps done/).catch(() => null);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(container.querySelector('section')).toBeNull();
  });
});
