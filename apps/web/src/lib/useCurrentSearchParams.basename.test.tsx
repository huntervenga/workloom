import { act, render, screen } from '@testing-library/react';
import { useContext } from 'react';
import { MemoryRouter, RouterProvider, UNSAFE_NavigationContext, createMemoryRouter, useBlocker, useLocation, useNavigate } from 'react-router';
import { describe, expect, it } from 'vitest';
import { useCurrentSearchParams } from './useCurrentSearchParams';

function mountedRouter(basename: string, blocked = false, initialPrefix?: string) {
  let actions: { open: () => boolean; week: () => boolean; close: () => boolean; elsewhere: () => void } | undefined;
  function Page() {
    const [, update] = useCurrentSearchParams();
    const location = useLocation();
    const navigate = useNavigate();
    const blocker = useBlocker(() => blocked);
    actions = {
      open: () => update(before => { before.set('task', 'parent'); return before; }),
      week: () => update(before => { before.set('week', 'explicit-week'); before.set('worker', 'visible-person'); return before; }),
      close: () => update(before => { before.delete('task'); return before; }),
      elsewhere: () => { void navigate('/elsewhere?fresh=kept#next'); },
    };
    return <><input aria-label="Unsent next task" defaultValue="Kept local draft" /><output data-testid="current-route">{location.pathname}{location.search}{location.hash}</output><output data-testid="blocker-state">{blocker.state}</output></>;
  }
  const prefix = initialPrefix ?? (basename === '/' ? '' : basename.replace(/\/$/, ''));
  const router = createMemoryRouter([{ path: '*', element: <Page /> }], { basename, initialEntries: [`${prefix}/project?other=kept#anchor`] });
  render(<RouterProvider router={router} />);
  return { router, current: () => { if (!actions) throw new Error('Missing mounted actions'); return actions; } };
}

describe('query navigation in the actual /app data router', () => {
  it.each(['/app', '/app/', '/'] as const)('opens task details and keeps same-act time changes, hash and mounted input (%s)', async basename => {
    const ui = mountedRouter(basename);
    const original = ui.current();
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Unsent next task' });
    input.focus(); input.setSelectionRange(2, 7);
    let opened = false; let selected = false;
    await act(async () => { opened = original.open(); selected = original.week(); });
    expect(opened).toBe(true); expect(selected).toBe(true);
    const path = basename === '/' ? '/project' : '/app/project';
    expect(ui.router.state.location.pathname).toBe(path);
    expect(new URLSearchParams(ui.router.state.location.search)).toEqual(new URLSearchParams('other=kept&task=parent&week=explicit-week&worker=visible-person'));
    expect(ui.router.state.location.hash).toBe('#anchor');
    expect(screen.getByRole('textbox', { name: 'Unsent next task' })).toBe(input);
    expect(input).toHaveValue('Kept local draft'); expect(input).toHaveFocus();
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 7]);
    await act(async () => { expect(original.close()).toBe(true); });
    expect(new URLSearchParams(ui.router.state.location.search).has('task')).toBe(false);
    expect(ui.router.state.location.pathname).toBe(path);
    expect(ui.router.state.location.hash).toBe('#anchor');
  });

  it('matches the router’s basename casing without adding a second prefix', async () => {
    const ui = mountedRouter('/app', false, '/APP');
    await act(async () => { expect(ui.current().open()).toBe(true); });
    expect(ui.router.state.location.pathname).toBe('/app/project');
    expect(new URLSearchParams(ui.router.state.location.search).get('task')).toBe('parent');
  });

  it.each(['/application/project', '/outside/app/project'])('refuses a declarative authoritative head outside the basename boundary (%s)', async pathname => {
    let update: (() => boolean) | undefined;
    function Page() {
      const [, change] = useCurrentSearchParams();
      update = () => change(before => { before.set('task', 'parent'); return before; });
      const location = useLocation();
      return <output data-testid="foreign-route">{location.pathname}{location.search}</output>;
    }
    function ForeignHead() {
      const context = useContext(UNSAFE_NavigationContext);
      return <UNSAFE_NavigationContext.Provider value={{ ...context, navigator: { ...context.navigator, location: { pathname, search: '?other=kept', hash: '' } } as typeof context.navigator }}><Page /></UNSAFE_NavigationContext.Provider>;
    }
    render(<MemoryRouter basename="/app" initialEntries={['/app/project?other=kept']}><ForeignHead /></MemoryRouter>);
    let accepted = true;
    await act(async () => { accepted = update?.() ?? true; });
    expect(accepted).toBe(false);
    expect(screen.getByTestId('foreign-route')).toHaveTextContent('/project?other=kept');
    expect(screen.getByTestId('foreign-route')).not.toHaveTextContent('task=');
  });

  it('continues through normal navigation so an active blocker refuses the prefixed query update', async () => {
    const ui = mountedRouter('/app', true);
    await act(async () => { ui.current().open(); });
    expect(screen.getByTestId('blocker-state')).toHaveTextContent('blocked');
    expect(ui.router.state.location).toMatchObject({ pathname: '/app/project', search: '?other=kept', hash: '#anchor' });
  });

  it('still refuses a retained control after the authoritative pathname changes', async () => {
    const ui = mountedRouter('/app'); const original = ui.current();
    await act(async () => original.elsewhere());
    let accepted = true; await act(async () => { accepted = original.open(); });
    expect(accepted).toBe(false);
    expect(ui.router.state.location).toMatchObject({ pathname: '/app/elsewhere', search: '?fresh=kept', hash: '#next' });
  });
});
