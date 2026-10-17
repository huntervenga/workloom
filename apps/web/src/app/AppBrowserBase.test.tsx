import { render, screen, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { createQueryClient } from '../lib/queryClient';
import { alpha, alphaMembers, anna, installFakeApi, singleActorRoutes } from '../test/fakeApi';

it('loads a direct /app deep link through the real browser router and keeps links and API calls on their own bases', async () => {
  const previousUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const deepLink = `/app/w/${alpha.id}/members`;
  // The router is a module singleton, so the location must be in place before App is first imported.
  window.history.replaceState({}, '', `${deepLink}?probe=kept#members`);
  const queryClient = createQueryClient({ retry: false });
  let view: ReturnType<typeof render> | undefined;
  try {
    const { calls, backgroundCalls } = installFakeApi(singleActorRoutes(anna, [alpha], { [alpha.id]: alphaMembers }));
    const { App } = await import('./App');
    view = render(<App queryClient={queryClient} />);

    expect(await screen.findByRole('heading', { level: 1, name: /members/i })).toBeInTheDocument();
    expect(await screen.findByText('Вера Образцова')).toBeInTheDocument();
    expect(window.location.pathname).toBe(deepLink);
    expect(window.location.search).toBe('?probe=kept');
    expect(window.location.hash).toBe('#members');

    // Internal links are rendered by React Router, so their hrefs carry the installed basename.
    await waitFor(() => {
      const hrefs = screen.getAllByRole('link').map(link => link.getAttribute('href') ?? '');
      expect(hrefs).toContain(deepLink);
    });
    const internal = screen.getAllByRole('link')
      .map(link => link.getAttribute('href') ?? '')
      .filter(href => href.startsWith('/') && !href.startsWith('//'));
    expect(internal.length).toBeGreaterThan(0);
    for (const href of internal) expect(href === '/app' || href.startsWith('/app/') || href.startsWith('/app?')).toBe(true);

    // The API stays at the site root and an ordinary read writes nothing.
    const requests = [...calls, ...backgroundCalls];
    expect(requests.some(request => request.path === `/api/v1/workspaces/${alpha.id}/memberships`)).toBe(true);
    for (const request of requests) {
      expect(request.path.startsWith('/api/')).toBe(true);
      expect(request.path.startsWith('/app/')).toBe(false);
      expect(request.method).toBe('GET');
    }
  } finally {
    view?.unmount();
    queryClient.clear();
    window.history.replaceState({}, '', previousUrl);
  }
});
