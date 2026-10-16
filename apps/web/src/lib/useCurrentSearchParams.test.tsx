import { act, render, screen } from '@testing-library/react';
import { useContext } from 'react';
import { MemoryRouter, RouterProvider, UNSAFE_NavigationContext, createMemoryRouter, useBlocker, useLocation, useNavigate } from 'react-router';
import { describe, expect, it } from 'vitest';
import { useCurrentSearchParams } from './useCurrentSearchParams';

interface Actions { close: () => void; week: () => boolean; chooseWeek: () => boolean; person: () => boolean; view: (value: string | null) => boolean; back: () => void; elsewhere: () => void }
function harness(kind: 'data' | 'declarative') {
  let actions: Actions | undefined;
  let oldWeek: (() => boolean) | undefined;
  function Page() {
    const [params, update] = useCurrentSearchParams();
    const navigate = useNavigate(); const location = useLocation();
    oldWeek ??= () => update(before => { const next = new URLSearchParams(before); next.set('week', 'new-week'); next.set('worker', 'new-person'); return next; });
    actions = { chooseWeek: () => update(before => { before.set('week', 'second-week'); return before; }), person: () => update(before => { before.set('worker', 'second-person'); return before; }), view: value => update(before => { if (value === null) before.delete('view'); else before.set('view', value); return before; }), close: () => { update(before => { const next = new URLSearchParams(before); next.delete('task'); return next; }); }, week: oldWeek,
      back: () => { void navigate(-1); }, elsewhere: () => { void navigate('/elsewhere?other=fresh#new'); } };
    return <output data-testid="location">{location.pathname}{params.toString() ? `?${params}` : ''}{location.hash}</output>;
  }
  const initial = '/project?task=old-task&view=board&other=kept&worker=old-person#anchor';
  if (kind === 'data') render(<RouterProvider router={createMemoryRouter([{ path: '*', element: <Page /> }], { initialEntries: [initial] })} />);
  else render(<MemoryRouter initialEntries={[initial]}><Page /></MemoryRouter>);
  return () => { if (!actions) throw new Error('Missing navigation actions'); return actions; };
}

describe('latest router search updates', () => {
  it.each(['data', 'declarative'] as const)('preserves the completed Close in the same act through an old callback (%s router) and respects back history', async kind => {
    const actions = harness(kind); const original = actions();
    let accepted = false;
    await act(async () => { original.close(); accepted = original.week(); });
    expect(accepted).toBe(true);
    const current = screen.getByTestId('location').textContent ?? '';
    expect(current).not.toContain('task='); expect(current).toContain('week=new-week'); expect(current).toContain('worker=new-person');
    expect(current).toContain('view=board'); expect(current).toContain('other=kept'); expect(current).toContain('#anchor');
    await act(async () => actions().back());
    expect(screen.getByTestId('location')).not.toHaveTextContent('task=');
    expect(screen.getByTestId('location')).not.toHaveTextContent('week=');
    expect(screen.getByTestId('location')).toHaveTextContent('worker=old-person');
    await act(async () => actions().back()); expect(screen.getByTestId('location')).toHaveTextContent('task=old-task');
  });

  for (const kind of ['data', 'declarative'] as const) {
    it.each(['board', 'graph', 'gantt', 'import', null])('keeps a same-act Close through a retained %s view callback (' + kind + ')', async view => {
      const actions = harness(kind); const retained = actions();
      await act(async () => { retained.close(); retained.view(view); });
      const current = screen.getByTestId('location').textContent ?? '';
      expect(current).not.toContain('task='); expect(current).toContain('other=kept'); expect(current).toContain('#anchor');
      if (view === null) expect(current).not.toContain('view='); else expect(current).toContain(`view=${view}`);
    });
    it('preserves a new time context through a retained view callback (' + kind + ')', async () => {
      const actions = harness(kind); const retained = actions();
      await act(async () => { retained.week(); retained.view('graph'); });
      expect(screen.getByTestId('location')).toHaveTextContent('week=new-week'); expect(screen.getByTestId('location')).toHaveTextContent('worker=new-person');
    });
    it.each(['week-person', 'person-week'] as const)('preserves both independent same-act picker changes in %s order (' + kind + ')', async order => {
      const actions = harness(kind); const retained = actions();
      await act(async () => retained.week());
      await act(async () => { if (order === 'week-person') { retained.chooseWeek(); retained.person(); } else { retained.person(); retained.chooseWeek(); } });
      const current = screen.getByTestId('location').textContent ?? '';
      expect(current).toContain('week=second-week'); expect(current).toContain('worker=second-person'); expect(current).toContain('other=kept');
    });
  }

  it.each(['data', 'declarative'] as const)('refuses an old control after the current pathname changes (%s router)', async kind => {
    const actions = harness(kind); const original = actions();
    await act(async () => original.elsewhere());
    let accepted = true; await act(async () => { accepted = original.week(); });
    expect(accepted).toBe(false); expect(screen.getByTestId('location')).toHaveTextContent('/elsewhere?other=fresh#new');
    expect(screen.getByTestId('location')).not.toHaveTextContent('week=');
  });

  it('uses normal data-router navigation so active blockers can refuse even a search change', async () => {
    let week: (() => void) | undefined;
    function Page() {
      const [, update] = useCurrentSearchParams(); const blocker = useBlocker(() => true); const location = useLocation();
      week = () => { update(before => { before.set('week', 'new-week'); return before; }); };
      return <><output data-testid="path">{location.search}</output><output data-testid="blocker">{blocker.state}</output></>;
    }
    render(<RouterProvider router={createMemoryRouter([{ path: '*', element: <Page /> }], { initialEntries: ['/project?other=kept'] })} />);
    await act(async () => week?.());
    expect(screen.getByTestId('blocker')).toHaveTextContent('blocked'); expect(screen.getByTestId('path')).toHaveTextContent('?other=kept');
  });

  it('does not navigate when an async guard declines and forwards replace without adding a history entry', async () => {
    let decline: (() => boolean) | undefined; let canonicalize: (() => void) | undefined; let back: (() => void) | undefined;
    function Page() {
      const [, update] = useCurrentSearchParams(); const location = useLocation(); const navigate = useNavigate();
      decline = () => update(() => null); canonicalize = () => { update(before => { before.set('week', 'canonical'); return before; }, { replace: true }); }; back = () => { void navigate(-1); };
      return <output data-testid="guard-location">{location.pathname}{location.search}:{location.key}</output>;
    }
    render(<RouterProvider router={createMemoryRouter([{ path: '*', element: <Page /> }], { initialEntries: ['/previous', '/project?other=kept'], initialIndex: 1 })} />);
    const previous = screen.getByTestId('guard-location').textContent; let accepted = true;
    await act(async () => { accepted = decline?.() ?? true; }); expect(accepted).toBe(false); expect(screen.getByTestId('guard-location').textContent).toBe(previous);
    await act(async () => canonicalize?.()); expect(screen.getByTestId('guard-location')).toHaveTextContent('week=canonical');
    await act(async () => back?.()); expect(screen.getByTestId('guard-location')).toHaveTextContent('/previous');
  });

  it('returns a controlled refusal when a custom declarative navigator exposes no authoritative location', async () => {
    let update: (() => boolean) | undefined;
    function Page() {
      const [params, change] = useCurrentSearchParams(); update = () => change(before => { before.set('week', 'new-week'); return before; });
      return <output data-testid="search">{params.toString()}</output>;
    }
    function WithoutHead() {
      const context = useContext(UNSAFE_NavigationContext);
      const navigator = context.navigator;
      return <UNSAFE_NavigationContext.Provider value={{ ...context, navigator: { createHref: navigator.createHref, go: navigator.go, push: navigator.push, replace: navigator.replace } }}><Page /></UNSAFE_NavigationContext.Provider>;
    }
    render(<MemoryRouter initialEntries={['/project?other=kept']}><WithoutHead /></MemoryRouter>);
    let accepted = true; await act(async () => { accepted = update?.() ?? true; });
    expect(accepted).toBe(false); expect(screen.getByTestId('search')).toHaveTextContent('other=kept'); expect(screen.getByTestId('search')).not.toHaveTextContent('week=');
  });
});
