// PRIVATE native BFF gate. Root owns the compiled API/DB and a trace-OFF one-worker config.
// This file starts only the in-memory test identity provider; it never starts/migrates/seeds Workloom.
import { randomUUID } from 'node:crypto';
import { expect, test, type Page, type Route } from '@playwright/test';
import { startFakeSharedAuth } from './support/fake-shared-auth.js';

const APP = 'http://127.0.0.1:49318';
const SESSION = '/api/v1/auth/session';
const ME = '/api/v1/me';
type Provider = Awaited<ReturnType<typeof startFakeSharedAuth>>;
type Submission = { accessToken: string; refreshToken: string; state: string };
type Me = { data: { actor: { id: string; displayName: string; kind: string }; authMode: string } };
type Workspaces = { data: { id: string; name: string; role: string }[] };
let provider: Provider;
let firstOwner: { actorId: string; workspaceId: string; projectId: string };

async function me(page: Page): Promise<Me> {
  const r = await page.request.get(`${APP}${ME}`);
  expect(r.status()).toBe(200);
  return r.json() as Promise<Me>;
}
async function workspaces(page: Page) {
  const r = await page.request.get(`${APP}/api/v1/workspaces`);
  expect(r.status()).toBe(200);
  return (await r.json() as Workspaces).data;
}
async function chooser(page: Page, account: 'A' | 'B') {
  await page.goto(`${APP}/app`);
  await page.getByRole('link', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Private test identity', exact: true })).toBeVisible();
  expect(new URL(page.url()).origin).toBe('http://127.0.0.1:49319');
  await page.getByRole('button', { name: `Continue as account ${account}`, exact: true }).click();
}
async function signedIn(page: Page, account: 'A' | 'B') {
  await chooser(page, account);
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  const identity = await me(page);
  expect(identity.data.authMode).toBe('shared');
  expect(identity.data.actor.kind).toBe('real');
  await noBrowserTokens(page);
  return identity;
}
async function noBrowserTokens(page: Page) {
  // Only booleans are returned: a failure never prints token/fragment/storage values.
  const clean = await page.evaluate(() => {
    const tokenish = /(?:access_token|refresh_token|eyJ[A-Za-z0-9_-]{10,}\.)/;
    const entries = (store: Storage) => Array.from({ length: store.length }, (_, i) => {
      const key = store.key(i) ?? ''; return `${key} ${store.getItem(key) ?? ''}`;
    });
    return {
      fragment: !location.hash,
      body: !tokenish.test(document.body.textContent ?? ''),
      local: !entries(localStorage).some(value => tokenish.test(value)),
      session: !entries(sessionStorage).some(value => tokenish.test(value)),
      cookies: !tokenish.test(document.cookie),
    };
  });
  expect(clean).toEqual({ fragment: true, body: true, local: true, session: true, cookies: true });
}
function capturedSubmission(route: Route): Submission {
  const value: unknown = route.request().postDataJSON();
  if (!value || typeof value !== 'object') throw new Error('Expected a callback submission object.');
  const body = value as Record<string, unknown>;
  // Assert only shape, never serialize credentials into a failure message.
  if (typeof body.accessToken !== 'string' || typeof body.refreshToken !== 'string' || typeof body.state !== 'string') throw new Error('Callback credential/state shape is invalid.');
  return { accessToken: body.accessToken, refreshToken: body.refreshToken, state: body.state };
}

test.describe('Shared Auth private BFF', () => {
  test.describe.configure({ mode: 'serial' });
  test.beforeAll(async ({ baseURL }) => {
    if (baseURL !== APP || process.env.WORKLOOM_QA_BASE_URL !== APP) throw new Error('Shared Auth native tests require explicit private QA http://127.0.0.1:49318; no fallback.');
    provider = await startFakeSharedAuth({ port: 49319, appOrigin: APP });
  });
  test.afterAll(async () => { await provider?.close(); });

  test('real BFF login provisions an empty owned workspace, permits project/task creation, survives reload and signs out', async ({ page }) => {
    const statsBefore = provider.stats();
    const identity = await signedIn(page, 'A');
    const statsAfter = provider.stats();
    expect(statsAfter.completedLogins - statsBefore.completedLogins).toBe(1);
    expect(statsAfter.refreshes - statsBefore.refreshes).toBe(1);
    expect(statsAfter.jwksReads).toBeGreaterThanOrEqual(1);
    const sessionCookie = (await page.context().cookies(APP)).find(cookie => cookie.name === 'workloom_session');
    expect(sessionCookie !== undefined).toBe(true);
    expect(sessionCookie?.httpOnly).toBe(true);
    expect(sessionCookie?.sameSite).toBe('Lax');
    expect(sessionCookie?.secure).toBe(false);
    const own = await workspaces(page);
    expect(own).toHaveLength(1); expect(own[0]?.role).toBe('owner');
    const workspaceId = own[0]?.id;
    if (!workspaceId) throw new Error('New real user has no owned workspace.');
    const projects = await page.request.get(`${APP}/api/v1/workspaces/${workspaceId}/projects`);
    expect(projects.status()).toBe(200);
    const before = await projects.json() as { data: unknown[] };
    expect(before.data).toEqual([]);
    await page.goto(`${APP}/app/w/${workspaceId}/projects`);
    await expect(page.getByRole('heading', { name: 'No projects yet', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'New project', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'New project', exact: true });
    const title = `Shared Auth native ${randomUUID()}`;
    await dialog.getByRole('textbox', { name: 'Project name', exact: true }).fill(title);
    await dialog.getByRole('button', { name: 'Create project', exact: true }).click();
    await page.getByRole('main').getByRole('link', { name: title, exact: true }).click();
    const projectId = /\/projects\/([^/?#]+)/.exec(new URL(page.url()).pathname)?.[1];
    if (!projectId) throw new Error('Created project route is missing its identity.');
    const taskTitle = `Shared Auth task ${randomUUID()}`;
    // The null-section group has its own accessible action; named sections use the quoted label.
    await page.getByRole('button', { name: 'Add task without a section', exact: true }).click();
    const input = page.getByRole('form', { name: 'Add a task to No section', exact: true }).getByRole('textbox', { name: 'Task name', exact: true });
    await input.fill(taskTitle); await input.press('Enter');
    await expect(page.getByRole('button', { name: taskTitle, exact: true })).toBeVisible();
    const tasks = await page.request.get(`${APP}/api/v1/workspaces/${workspaceId}/tasks`, { params: { projectId } });
    expect(tasks.status()).toBe(200);
    const stored = await tasks.json() as { data: { title: string }[] };
    expect(stored.data.filter(task => task.title === taskTitle)).toHaveLength(1);
    await page.reload();
    expect((await me(page)).data.actor.id).toBe(identity.data.actor.id);
    await expect(page.getByRole('button', { name: taskTitle, exact: true })).toBeVisible();
    await noBrowserTokens(page);
    expect([403, 404]).toContain((await page.request.get(`${APP}/api/v1/dev/actors`)).status());
    await expect(page.getByRole('combobox', { name: /demo|development actor/i })).toHaveCount(0);
    firstOwner = { actorId: identity.data.actor.id, workspaceId, projectId };
    const logout = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/v1/auth/logout');
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    expect((await logout).status()).toBe(204);
    await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
    expect((await page.request.get(`${APP}${ME}`)).status()).toBe(401);
    expect((await page.context().cookies(APP)).some(cookie => cookie.name === 'workloom_session')).toBe(false);
    await expect.poll(() => provider.stats().logouts).toBeGreaterThan(statsAfter.logouts);
    await noBrowserTokens(page);
  });

  test('a different Auth sub with the same email/name gets a separate local owner and cannot read the first owner project', async ({ page }) => {
    expect(provider.identities.a.email).toBe(provider.identities.b.email);
    expect(provider.identities.a.name).toBe(provider.identities.b.name);
    expect(provider.identities.a.id).not.toBe(provider.identities.b.id);
    const identity = await signedIn(page, 'B');
    expect(identity.data.actor.id).not.toBe(firstOwner.actorId);
    const own = await workspaces(page);
    expect(own).toHaveLength(1); expect(own[0]?.role).toBe('owner');
    expect(own.some(w => w.id === firstOwner.workspaceId)).toBe(false);
    const denied = await page.request.get(`${APP}/api/v1/workspaces/${firstOwner.workspaceId}/projects/${firstOwner.projectId}`);
    expect([403, 404]).toContain(denied.status());
    await noBrowserTokens(page);
  });

  test('malformed callback credentials are stripped without a session or browser token persistence', async ({ page }) => {
    await page.goto(`${APP}/app/auth/callback#access_token=invalid-token&refresh_token=invalid-refresh&state=invalid-state`);
    await expect(page.getByRole('link', { name: 'Start sign-in again', exact: true })).toBeVisible();
    expect((await page.request.get(`${APP}${ME}`)).status()).toBe(401);
    await noBrowserTokens(page);
  });

  test('valid callback credentials cannot establish a session in another browser without the login transaction cookie', async ({ page, browser }) => {
    let submitted: Submission | undefined;
    await page.route(`**${SESSION}`, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      submitted = capturedSubmission(route); await route.abort('failed');
    });
    const refreshes = provider.stats().refreshes;
    await chooser(page, 'A');
    await expect.poll(() => submitted !== undefined).toBe(true);
    if (!submitted) throw new Error('Callback was not submitted.');
    const stranger = await browser.newContext({ baseURL: APP });
    try {
      const result = await stranger.request.post(`${APP}${SESSION}`, { data: submitted, headers: { origin: APP } });
      expect(result.status()).toBe(401);
      expect((await stranger.request.get(`${APP}${ME}`)).status()).toBe(401);
      expect(provider.stats().refreshes).toBe(refreshes);
    } finally { await stranger.close(); }
    expect((await page.request.get(`${APP}${ME}`)).status()).toBe(401);
    await noBrowserTokens(page);
  });

  test('a consumed callback state cannot replay into a new browser session', async ({ page }) => {
    let submitted: Submission | undefined;
    await page.route(`**${SESSION}`, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      submitted = capturedSubmission(route); await route.continue();
    });
    await signedIn(page, 'A');
    if (!submitted) throw new Error('Successful callback was not captured.');
    const refreshes = provider.stats().refreshes;
    await page.context().clearCookies();
    const replay = await page.request.post(`${APP}${SESSION}`, { data: submitted, headers: { origin: APP } });
    expect(replay.status()).toBe(401);
    expect(provider.stats().refreshes).toBe(refreshes);
    expect((await page.request.get(`${APP}${ME}`)).status()).toBe(401);
    submitted = undefined;
  });

  test('lost callback response body after a real commit is recovered only through explicit Check sign-in, never callback resubmission', async ({ page }) => {
    let posts = 0;
    await page.route(`**${SESSION}`, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      posts += 1;
      const actual = await route.fetch();
      expect(actual.status()).toBe(200);
      // Real server commit and real Set-Cookie reach the browser; only its JSON body is lost.
      await route.fulfill({ response: actual, body: '' });
    });
    await chooser(page, 'A');
    const check = page.getByRole('button', { name: 'Check sign-in', exact: true });
    await expect(check).toBeVisible();
    expect(posts).toBe(1);
    await noBrowserTokens(page);
    await check.click();
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
    expect((await me(page)).data.actor.kind).toBe('real');
    expect(posts).toBe(1);
    await noBrowserTokens(page);
  });
});
