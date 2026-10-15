import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { queryKeys } from '../lib/queryKeys';
import {
  alpha,
  alphaMembers,
  anna,
  beta,
  betaMembers,
  boris,
  deferred,
  failure,
  installFakeApi,
  ok,
  renderApp,
  singleActorRoutes,
  type FakeRequest,
} from '../test/fakeApi';

const leakyMessage = "select * from memberships where token = 'sk_live_hunter2'";

describe('identity and workspace loading', () => {
  it('shows a loading status, then the workspace and actor from the API', async () => {
    const me = deferred<Response>();
    installFakeApi({
      ...singleActorRoutes(anna, [alpha], { [alpha.id]: alphaMembers }),
      'GET /api/v1/me': () => me.promise,
    });

    renderApp('/');
    expect(screen.getByRole('status')).toHaveTextContent('Загрузка Workloom');

    me.resolve(ok({ actor: anna, authMode: 'dev' }));

    expect(await screen.findByRole('heading', { level: 1, name: alpha.name })).toBeInTheDocument();
    expect(screen.getAllByText(anna.displayName).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Локальный режим — тестовый пользователь').length).toBeGreaterThan(0);
    expect(await screen.findByText('Вера Образцова')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Все участники/ })).toHaveAttribute('href', `/w/${alpha.id}/members`);
  });

  it('shows a safe identity error and recovers on retry', async () => {
    let attempts = 0;
    installFakeApi({
      ...singleActorRoutes(anna, [alpha]),
      'GET /api/v1/me': () => {
        attempts += 1;
        return attempts === 1 ? failure(500, 'INTERNAL_ERROR', leakyMessage) : ok({ actor: anna, authMode: 'dev' });
      },
    });

    const { user } = renderApp('/');

    expect(await screen.findByRole('heading', { name: 'Не удалось определить пользователя' })).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/hunter2|select \*/);

    await user.click(screen.getByRole('button', { name: 'Повторить' }));

    expect(await screen.findByRole('heading', { level: 1, name: alpha.name })).toBeInTheDocument();
  });

  it('explains when the actor has no workspaces', async () => {
    installFakeApi(singleActorRoutes(anna, []));

    renderApp('/');

    expect(await screen.findByRole('heading', { level: 1, name: 'Нет доступных пространств' })).toBeInTheDocument();
  });

  it('does not reveal a workspace the actor cannot access', async () => {
    const { calls } = installFakeApi({
      ...singleActorRoutes(anna, [alpha]),
      [`GET /api/v1/workspaces/${beta.id}`]: () => failure(404, 'NOT_FOUND', `Workspace «${beta.name}» is hidden`),
    });

    const { user } = renderApp(`/w/${beta.id}`);

    expect(await screen.findByRole('heading', { level: 1, name: 'Пространство недоступно' })).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('Бета');
    expect(calls.some((call) => call.path.endsWith('/memberships'))).toBe(false);

    await user.click(screen.getByRole('link', { name: 'К доступным пространствам' }));

    expect(await screen.findByRole('heading', { level: 1, name: alpha.name })).toBeInTheDocument();
  });
});

describe('members', () => {
  it('shows a member list error with retry, then the members with the current actor marked', async () => {
    let attempts = 0;
    installFakeApi({
      ...singleActorRoutes(anna, [alpha]),
      [`GET /api/v1/workspaces/${alpha.id}/memberships`]: () => {
        attempts += 1;
        return attempts === 1 ? failure(503, 'TEMPORARILY_UNAVAILABLE', leakyMessage) : ok(alphaMembers);
      },
    });

    const { user } = renderApp(`/w/${alpha.id}/members`);

    expect(await screen.findByRole('heading', { name: 'Не удалось загрузить участников' })).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('hunter2');

    await user.click(screen.getByRole('button', { name: 'Повторить' }));

    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(alphaMembers.length + 1);
    const annaRow = within(table).getByText(anna.displayName).closest('tr');
    expect(annaRow).not.toBeNull();
    expect(within(annaRow as HTMLElement).getByText('Вы')).toBeInTheDocument();
    expect(within(table).getByText('Администратор')).toBeInTheDocument();
  });

  it('removes loaded members when a refresh is denied', async () => {
    let revoked = false;
    installFakeApi({
      ...singleActorRoutes(anna, [alpha], { [alpha.id]: alphaMembers }),
      'GET /api/v1/workspaces': () => ok(revoked ? [] : [alpha]),
      [`GET /api/v1/workspaces/${alpha.id}`]: () => (revoked ? failure(404, 'NOT_FOUND', 'gone') : ok(alpha)),
      [`GET /api/v1/workspaces/${alpha.id}/memberships`]: () =>
        revoked ? failure(404, 'NOT_FOUND', 'gone') : ok(alphaMembers),
    });

    const { user } = renderApp(`/w/${alpha.id}/members`);
    expect(await screen.findByText('Вера Образцова')).toBeInTheDocument();

    revoked = true;
    await user.click(screen.getByRole('button', { name: 'Обновить' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Пространство недоступно' })).toBeInTheDocument();
    expect(screen.queryByText('Вера Образцова')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(alpha.name)).not.toBeInTheDocument());
  });
});

describe('switching context', () => {
  it('drops the previous workspace cache when another workspace is chosen', async () => {
    installFakeApi(singleActorRoutes(anna, [alpha, beta], { [alpha.id]: alphaMembers, [beta.id]: betaMembers }));

    const { user, queryClient } = renderApp(`/w/${alpha.id}`);
    expect(await screen.findByRole('heading', { level: 1, name: alpha.name })).toBeInTheDocument();

    screen.getByRole('button', { name: /^Пространство/ }).focus();
    await user.keyboard('{Enter}');
    await user.click(await screen.findByRole('menuitemradio', { name: new RegExp(beta.name) }));

    expect(await screen.findByRole('heading', { level: 1, name: beta.name })).toBeInTheDocument();
    expect(queryClient.getQueryCache().findAll({ queryKey: queryKeys.workspace(anna.id, alpha.id) })).toHaveLength(0);
  });

  it('hides the previous actor immediately and loads the new actor after a dev switch', async () => {
    let current = anna;
    const sessionReply = deferred<undefined>();
    const { calls } = installFakeApi({
      'GET /api/v1/me': () => ok({ actor: current, authMode: 'dev' }),
      'GET /api/v1/dev/actors': () => ok([anna, boris]),
      'GET /api/v1/workspaces': () => ok(current === anna ? [alpha] : [beta]),
      [`GET /api/v1/workspaces/${alpha.id}`]: () => (current === anna ? ok(alpha) : failure(404, 'NOT_FOUND', 'hidden')),
      [`GET /api/v1/workspaces/${alpha.id}/memberships`]: () => ok(alphaMembers),
      [`GET /api/v1/workspaces/${beta.id}`]: () => (current === boris ? ok(beta) : failure(404, 'NOT_FOUND', 'hidden')),
      [`GET /api/v1/workspaces/${beta.id}/memberships`]: () => ok(betaMembers),
      'POST /api/v1/dev/session': async () => {
        await sessionReply.promise;
        current = boris;
        return ok({ actor: boris, authMode: 'dev' });
      },
    });

    const { user, queryClient } = renderApp('/');
    expect(await screen.findByRole('heading', { level: 1, name: alpha.name })).toBeInTheDocument();

    (await screen.findByRole('button', { name: /Сменить пользователя/ })).focus();
    await user.keyboard('{Enter}');
    await user.click(await screen.findByRole('menuitemradio', { name: /Борис/ }));

    // The server has not answered yet, but nothing of the previous actor is on screen.
    expect(screen.queryByText(alpha.name)).not.toBeInTheDocument();
    expect(screen.queryByText(anna.displayName)).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Переключаем тестового пользователя');
    await waitFor(() =>
      expect(queryClient.getQueryCache().findAll({ queryKey: queryKeys.actor(anna.id) })).toHaveLength(0),
    );

    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    const post = calls.find((call: FakeRequest) => call.method === 'POST');
    expect(post).toMatchObject({ path: '/api/v1/dev/session', body: { actorId: boris.id }, credentials: 'same-origin' });
    expect(post?.headers.get('x-workloom-dev-tool')).toBe('1');
    expect(calls.filter((call) => call.method === 'GET').every((call) => !call.headers.has('x-workloom-dev-tool'))).toBe(
      true,
    );

    sessionReply.resolve(undefined);

    expect(await screen.findByRole('heading', { level: 1, name: beta.name })).toBeInTheDocument();
    expect(screen.getAllByText(boris.displayName).length).toBeGreaterThan(0);
    expect(screen.queryByText(alpha.name)).not.toBeInTheDocument();
  });

  it('reports a rejected switch and shows whoever the server still reports', async () => {
    installFakeApi({
      ...singleActorRoutes(anna, [alpha], { [alpha.id]: alphaMembers }),
      'GET /api/v1/dev/actors': () => ok([anna, boris]),
      'POST /api/v1/dev/session': () => failure(403, 'FORBIDDEN', leakyMessage),
    });

    const { user } = renderApp('/');
    expect(await screen.findByRole('heading', { level: 1, name: alpha.name })).toBeInTheDocument();

    (await screen.findByRole('button', { name: /Сменить пользователя/ })).focus();
    await user.keyboard('{Enter}');
    await user.click(await screen.findByRole('menuitemradio', { name: /Борис/ }));

    expect(await screen.findByText('Не удалось сменить тестового пользователя')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { level: 1, name: alpha.name })).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('hunter2');
  });
});
