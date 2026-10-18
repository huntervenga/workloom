// Private compiled BFF only. The root owns API/PG lifecycle; this starts only the in-memory Auth fixture.
import { randomUUID } from 'node:crypto';
import { expect, test, type APIResponse, type Locator, type Page } from '@playwright/test';
import { startFakeSharedAuth } from './support/fake-shared-auth.js';

const APP = 'http://127.0.0.1:49318';
const PHOTO = 'https://images.example.com/profile.png';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGN44JDwHwAGBAKAmdmy9AAAAABJRU5ErkJggg==', 'base64');
type Provider = Awaited<ReturnType<typeof startFakeSharedAuth>>;
type Actor = { id: string; displayName: string; avatarUrl?: string | null };
type Member = { id: string; userId: string; avatarUrl?: string | null };
let provider: Provider;

async function data<T>(response: Pick<APIResponse, 'status' | 'json'>, status: number): Promise<T> {
  expect(response.status()).toBe(status);
  return (await response.json() as { data: T }).data;
}
async function readActor(page: Page) {
  return (await data<{ actor: Actor; authMode: string }>(await page.request.get(`${APP}/api/v1/me`), 200)).actor;
}
async function signedIn(page: Page, identity: ReturnType<Provider['registerIdentity']>) {
  await page.goto(`${APP}/app`);
  await page.getByRole('link', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Private test identity', exact: true })).toBeVisible();
  await page.getByRole('button', { name: identity.buttonName, exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  return readActor(page);
}
async function loadedImage(image: Locator) {
  await expect(image).toBeVisible();
  await expect(image).toHaveAttribute('referrerpolicy', 'no-referrer');
  await expect(image).toHaveAttribute('width', '24');
  await expect(image).toHaveAttribute('height', '24');
  await expect(image).toHaveJSProperty('complete', true);
  await expect(image).toHaveJSProperty('naturalWidth', 1);
}
async function noPageOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
}
function observe(page: Page) {
  const errors: string[] = [], badApi: number[] = [];
  page.on('pageerror', error => errors.push(error.name));
  page.on('response', response => {
    if (new URL(response.url()).pathname.startsWith('/api/') && response.status() >= 400 && response.status() !== 401) badApi.push(response.status());
  });
  return () => { expect(errors).toEqual([]); expect(badApi).toEqual([]); };
}

test.describe('Verified profile photos on the private compiled app', () => {
  test.describe.configure({ mode: 'serial', timeout: 150_000 });
  test.beforeAll(async ({ baseURL }, info) => {
    if (baseURL !== APP || process.env.WORKLOOM_QA_BASE_URL !== APP) throw new Error('Profile photo native gate requires explicit private49318.');
    if (info.project.use.trace !== 'off' || info.project.use.video !== 'off') throw new Error('Profile photo native gate requires trace/video OFF.');
    provider = await startFakeSharedAuth({ port: 49319, appOrigin: APP });
  });
  test.afterAll(async () => { await provider?.close(); });

  for (const width of [1440, 390]) {
    test(`signed provider picture persists in account, member, assignee and comment after reload at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const clean = observe(page);
      let imageRequests = 0;
      await page.route(PHOTO, async route => { imageRequests += 1; await route.fulfill({ status: 200, contentType: 'image/png', body: PNG }); });
      const identity = provider.registerIdentity(`Photo ${width} ${randomUUID()}`, { picture: PHOTO });
      const actor = await signedIn(page, identity);
      expect(actor.avatarUrl).toBe(PHOTO);
      const accountImage = page.locator('header').locator(`img[src="${PHOTO}"]`);
      await loadedImage(accountImage);
      const workspaces = await data<{ id: string; role: string }[]>(await page.request.get(`${APP}/api/v1/workspaces`), 200);
      expect(workspaces).toHaveLength(1);
      const workspaceId = workspaces[0]?.id;
      if (!workspaceId) throw new Error('Expected the synthetic account owner workspace.');
      const prefix = `${APP}/api/v1/workspaces/${workspaceId}`;
      const members = await data<Member[]>(await page.request.get(`${prefix}/memberships`), 200);
      expect(members).toHaveLength(1);
      const member = members.find(value => value.userId === actor.id);
      expect(member?.avatarUrl).toBe(PHOTO);
      if (!member) throw new Error('Expected the synthetic account owner membership.');
      const post = async <T,>(path: string, body: unknown): Promise<T> => data<T>(await page.request.post(`${prefix}${path}`, {
        headers: { Origin: APP, 'Idempotency-Key': randomUUID() }, data: body,
      }), 201);
      const project = await post<{ id: string }>('/projects', { name: `Photo project ${randomUUID()}` });
      const statuses = await data<{ id: string; group: string }[]>(await page.request.get(`${prefix}/projects/${project.id}/statuses`), 200);
      const status = statuses.find(value => value.group === 'todo');
      if (!status) throw new Error('Expected the new project todo status.');
      const title = `Photo task ${randomUUID()}`;
      const task = await post<{ id: string }>('/tasks', { projectId: project.id, title, statusId: status.id,
        responsibleMembershipId: member.id, participantMembershipIds: [member.id] });
      const projectUrl = `${APP}/app/w/${workspaceId}/projects/${project.id}`;
      const open = async () => {
        await page.goto(projectUrl);
        const row = page.locator(`tr[data-task-row="${task.id}"]`);
        await expect(row).toBeVisible();
        await loadedImage(row.locator(`img[src="${PHOTO}"]`).first());
        await row.getByRole('button', { name: `Open task “${title}”`, exact: true }).click();
        return page.getByRole('region', { name: 'Activity', exact: true });
      };
      const activity = await open();
      const body = `Signed photo comment ${randomUUID()}`;
      await activity.getByRole('textbox', { name: 'Comment', exact: true }).fill(body);
      const answer = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/v1/workspaces/${workspaceId}/tasks/${task.id}/comments`);
      await activity.getByRole('button', { name: 'Add comment', exact: true }).click();
      const comment = await data<{ id: string; body: string; authorAvatarUrl?: string | null }>(await answer, 201);
      expect(comment.body).toBe(body);
      expect(comment.authorAvatarUrl).toBe(PHOTO);
      const commentRow = page.locator(`li[data-task-comment-id="${comment.id}"]`);
      await expect(commentRow).toContainText(body);
      await loadedImage(commentRow.locator(`img[src="${PHOTO}"]`));
      await page.reload();
      expect((await readActor(page)).avatarUrl).toBe(PHOTO);
      await open();
      await expect(commentRow).toContainText(body);
      await loadedImage(commentRow.locator(`img[src="${PHOTO}"]`));
      const savedComments = await data<{ id: string; body: string; authorAvatarUrl?: string | null }[]>(await page.request.get(`${prefix}/tasks/${task.id}/comments`), 200);
      expect(savedComments.find(value => value.id === comment.id)).toMatchObject({ body, authorAvatarUrl: PHOTO });
      expect(imageRequests).toBeGreaterThan(0);
      await noPageOverflow(page); clean();
    });
  }

  test('failed provider image falls back to initials at390 without losing the signed-in account', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    const clean = observe(page); let imageRequests = 0;
    await page.route(PHOTO, async route => { imageRequests += 1; await route.fulfill({ status: 503, body: '' }); });
    const actor = await signedIn(page, provider.registerIdentity(`Failed photo ${randomUUID()}`, { picture: PHOTO }));
    expect(actor.avatarUrl).toBe(PHOTO);
    await expect(page.locator('header').locator('img')).toHaveCount(0);
    await expect(page.locator('header').getByText('QA', { exact: true })).toBeVisible();
    expect(imageRequests).toBeGreaterThan(0);
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
    await noPageOverflow(page); clean();
  });

  test('provider without a picture renders initials and never requests a photo', async ({ page }) => {
    const clean = observe(page); let photoRequests = 0;
    await page.route('https://images.example.com/**', async route => { photoRequests += 1; await route.abort(); });
    const actor = await signedIn(page, provider.registerIdentity(`No photo ${randomUUID()}`));
    expect(actor.avatarUrl ?? null).toBeNull();
    await expect(page.locator('header').locator('img')).toHaveCount(0);
    await expect(page.locator('header').getByText('QA', { exact: true })).toBeVisible();
    expect(photoRequests).toBe(0);
    await page.reload();
    expect((await readActor(page)).avatarUrl ?? null).toBeNull();
    await expect(page.locator('header').getByText('QA', { exact: true })).toBeVisible();
    clean();
  });
});
