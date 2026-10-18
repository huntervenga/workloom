// Root-owned private fake Auth + throwaway PostgreSQL only. No production services or account data.
// Invitation strings stay in local test memory: no trace, screenshots, attachments or raw-body logs.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { meResponseSchema, teamInvitationResponseSchema, teamViewResponseSchema } from '@workloom/contracts';
import { startFakeSharedAuth } from './support/fake-shared-auth.js';
import { PRIVATE_APP as APP, apiRead, freshProject } from './support/asana-private-project.js';
import { requirePrivateMembershipDatabase } from './support/private-membership-fixture.js';

let provider: Awaited<ReturnType<typeof startFakeSharedAuth>>;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => { requirePrivateMembershipDatabase(); provider = await startFakeSharedAuth({ port: 49319, appOrigin: APP }); });
test.afterAll(async () => { await provider?.close(); });
const safeHash = (text: string) => createHash('sha256').update(text).digest('hex');
const noRawCredential = async (page: Page, secret: string) => {
  const result = await page.evaluate(value => ({
    fragmentGone: window.location.hash === '',
    htmlClean: !document.documentElement.outerHTML.includes(value),
    localClean: !JSON.stringify(localStorage).includes(value),
    sessionClean: !JSON.stringify(sessionStorage).includes(value),
  }), secret);
  expect(result).toEqual({ fragmentGone: true, htmlClean: true, localClean: true, sessionClean: true });
};

test('owner generates one hash-only invitation and can copy its fragment link without rendering the credential', async ({ page, context }) => {
  const fixture = await freshProject(page, provider, 'Team invitation manager');
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: APP });
  await page.goto(`${APP}/app/w/${fixture.workspaceId}/members`);
  const create = page.getByRole('button', { name: 'Create invitation', exact: true });
  await expect(create).toBeEnabled();
  const answer = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `${fixture.prefix}/invitations`);
  await create.click();
  const response = await answer;
  expect(response.status()).toBe(201);
  const input = response.request().postDataJSON() as Record<string, unknown>;
  expect(Object.keys(input).sort()).toEqual(['expiresInSeconds', 'hashVersion', 'id', 'role', 'secretHash']);
  expect(input['secretHash']).toMatch(/^[a-f0-9]{64}$/);
  expect(response.request().headers()['x-workloom-actor-id']).toBe(fixture.actorId);
  await page.getByRole('button', { name: 'Copy invitation link', exact: true }).click();
  const raw = await page.evaluate(() => navigator.clipboard.readText());
  const link = new URL(raw);
  const [id, secret = ''] = link.hash.slice(1).split('.');
  expect(link.origin).toBe(APP); expect(link.pathname).toBe('/app/join'); expect(link.search).toBe('');
  expect(secret.length).toBe(43);
  const expected = safeHash(`workloom-invite:v1:${id}:${Buffer.from(secret, 'base64url').toString('hex')}`);
  expect(input['secretHash']).toBe(expected);
  await noRawCredential(page, secret);
  const team = (await apiRead(page, `${fixture.prefix}/team`, teamViewResponseSchema)).data;
  expect(team.invitations.filter(invite => invite.id === input['id'])).toHaveLength(1);
  expect(JSON.stringify(team).includes(secret)).toBe(false);
});

test('anonymous invite requires sign-in then reopen; explicit accept retries the exact unknown command once', async ({ page, browser }) => {
  const fixture = await freshProject(page, provider, 'Team invitation acceptance');
  const invitationId = randomUUID(), bytes = randomBytes(32), secret = bytes.toString('base64url');
  const issued = await page.request.post(`${APP}${fixture.prefix}/invitations`, {
    headers: { Origin: APP, 'Idempotency-Key': randomUUID(), 'X-Workloom-Actor-ID': fixture.actorId },
    data: { id: invitationId, hashVersion: 1, secretHash: safeHash(`workloom-invite:v1:${invitationId}:${bytes.toString('hex')}`), role: 'member', expiresInSeconds: 86400 },
  });
  expect(issued.status()).toBe(201); teamInvitationResponseSchema.parse(await issued.json());
  const recipient = provider.registerIdentity(`Team recipient ${randomUUID()}`);
  const context = await browser.newContext();
  const guest = await context.newPage();
  try {
    const commands: { key: string | undefined; bodyHash: string; actor: string | undefined }[] = [];
    guest.on('request', request => {
      if (new URL(request.url()).pathname === '/api/v1/invitations/accept' && request.method() === 'POST') commands.push({ key: request.headers()['idempotency-key'], bodyHash: safeHash(request.postData() ?? ''), actor: request.headers()['x-workloom-actor-id'] });
    });
    await guest.goto(`${APP}/app/join#${invitationId}.${secret}`);
    await expect(guest.getByText('Sign in first, then reopen the original invitation link. Invitation credentials are never forwarded to sign-in.', { exact: true })).toBeVisible();
    await noRawCredential(guest, secret);
    const signIn = guest.getByRole('link', { name: 'Sign in', exact: true });
    const href = await signIn.getAttribute('href'); expect((href ?? '').includes(secret)).toBe(false);
    await signIn.click();
    await guest.getByRole('button', { name: recipient.buttonName, exact: true }).click();
    await expect(guest.getByText('Open your invitation link again while signed in to accept it.', { exact: true })).toBeVisible();
    expect(commands).toHaveLength(0);
    await guest.goto(`${APP}/app/join#${invitationId}.${secret}`);
    const accept = guest.getByRole('button', { name: 'Accept invitation', exact: true });
    await expect(accept).toBeEnabled(); await noRawCredential(guest, secret);
    const me = (await apiRead(guest, '/api/v1/me', meResponseSchema)).data;
    let first = true;
    await guest.route('**/api/v1/invitations/accept', async route => {
      if (!first) { await route.continue(); return; }
      first = false;
      const actual = await route.fetch();
      expect(actual.status()).toBe(200);
      // Model a committed response lost on its way back, without altering the server's write.
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'Private test response loss' } }) });
    });
    await accept.click();
    await expect(guest.getByRole('button', { name: 'Retry same action', exact: true })).toBeEnabled();
    expect(commands).toHaveLength(1);
    await guest.getByRole('button', { name: 'Retry same action', exact: true }).click();
    await expect.poll(() => new URL(guest.url()).pathname).toBe(`/app/w/${fixture.workspaceId}/projects`);
    expect(commands).toHaveLength(2);
    expect(commands[0]).toEqual(commands[1]);
    expect(commands[0]?.actor).toBe(me.actor.id);
    const team = (await apiRead(page, `${fixture.prefix}/team`, teamViewResponseSchema)).data;
    expect(team.members.filter(member => member.userId === me.actor.id && member.state === 'active')).toHaveLength(1);
    expect(team.invitations.find(invite => invite.id === invitationId)?.acceptedByUserId).toBe(me.actor.id);
    await noRawCredential(guest, secret);
  } finally { await context.close(); }
});
