// P0 browser smoke: React shell → Vite /api proxy → Fastify → PostgreSQL.
// Expected names come from the live API (see support/live-api.ts), never from hard-coded fixtures.
// Route mocks are used only for the loading, error and empty UI states and say so in their titles.
// This is local dev-identity mode on synthetic data; it does not cover real auth or private meetings.
import { expect, test, type Page, type Route } from '@playwright/test';

import { loadLiveData, type LiveData } from './support/live-api.js';

const WORKSPACE_LIST = '**/api/v1/workspaces';

let live: LiveData;

test.beforeAll(async ({ request }) => {
  live = await loadLiveData(request);
});

// This entire shell suite is read-only, including real-response state probes.
const blockedWrites: string[] = [];
test.beforeEach(async ({ page }) => {
  blockedWrites.length = 0;
  await page.route('**/*', async route => {
    const method = route.request().method();
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) await route.continue();
    else { blockedWrites.push(`${method} ${new URL(route.request().url()).pathname}`); await route.abort(); }
  });
});
test.afterEach(() => { expect(blockedWrites, 'shell test attempted no mutations').toEqual([]); });

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.documentElement.clientWidth,
  }));
  expect(overflow.document, 'page-level horizontal overflow (px)').toBeLessThanOrEqual(0);
  expect(overflow.body, 'body horizontal overflow (px)').toBeLessThanOrEqual(0);
}

test.describe('desktop', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('real API and database: workspace, dev identity and persisted members', async ({ page }, testInfo) => {
    const { me, firstWorkspace, members } = live;
    const listResponse = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/v1/workspaces' && response.status() === 200,
    );

    await page.goto('/');
    await listResponse;
    await expect(page).toHaveURL(new RegExp(`/w/${firstWorkspace.id}$`));

    const main = page.getByRole('main');
    await expect(main.getByRole('heading', { level: 1, name: firstWorkspace.name })).toBeVisible();
    await expect(page.getByRole('navigation', { name: "Breadcrumbs" })).toContainText(firstWorkspace.name);

    const sidebar = page.getByRole('complementary', { name: "Sidebar" });
    const localMode = sidebar.getByRole('region', { name: "Local demo" });
    await expect(localMode).toBeVisible();
    await expect(localMode).toContainText(me.actor.displayName);

    await sidebar.getByRole('link', { name: "Members" }).click();
    await expect(page).toHaveURL(new RegExp(`/w/${firstWorkspace.id}/members$`));
    await expect(main.getByRole('heading', { level: 1, name: "Members" })).toBeVisible();

    const table = main.getByRole('table');
    // Header row + one row per persisted active membership.
    await expect(table.getByRole('row')).toHaveCount(members.length + 1);
    for (const member of members) {
      await expect(table.getByRole('row').filter({ hasText: member.displayName })).toHaveCount(1);
    }
    const ownRow = table.getByRole('row').filter({ hasText: me.actor.displayName });
    await expect(ownRow.getByTitle("Current user")).toBeVisible();

    await page.screenshot({ path: testInfo.outputPath('p0-desktop-members.png'), fullPage: true });
  });

  test('real API: an unknown workspace id shows the unavailable state', async ({ page }) => {
    await page.goto('/w/00000000-0000-4000-8000-00000000dead');
    const main = page.getByRole('main');
    await expect(main.getByRole('heading', { level: 1, name: "Workspace unavailable" })).toBeVisible();
    await expect(main.getByRole('link', { name: "Back to available workspaces" })).toBeVisible();
  });

  test('UI state (delayed real response): loading is shown until the workspace list arrives', async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route(WORKSPACE_LIST, async (route: Route) => {
      await gate;
      await route.continue();
    });

    await page.goto('/');
    const loading = page.getByRole('main').getByRole('status').filter({ hasText: "Loading workspaces" });
    await expect(loading).toBeVisible();

    release();
    await expect(page.getByRole('main').getByRole('heading', { level: 1, name: live.firstWorkspace.name })).toBeVisible();
    await expect(loading).toHaveCount(0);
  });

  test('UI state (mocked 503): error with accessible retry, retry reaches the real backend', async ({ page }) => {
    let mockedCalls = 0;
    await page.route(WORKSPACE_LIST, async (route: Route) => {
      mockedCalls += 1;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'TEMPORARILY_UNAVAILABLE', message: 'mocked outage', retryable: true },
          meta: { requestId: 'req_e2e_503' },
        }),
      });
    });

    await page.goto('/');
    const main = page.getByRole('main');
    const alert = main.getByRole('alert');
    // The query client retries 503 twice with backoff before showing the error.
    await expect(alert.getByRole('heading', { level: 1, name: "Unable to load workspaces" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(alert).toContainText('The service is temporarily unavailable');
    await expect(alert).toContainText('req_e2e_503');
    await expect(alert).not.toContainText('mocked outage');
    expect(mockedCalls).toBeGreaterThanOrEqual(1);

    await page.unroute(WORKSPACE_LIST);
    const realResponse = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/v1/workspaces' && response.status() === 200,
    );
    await alert.getByRole('button', { name: "Try again" }).click();
    await realResponse;
    await expect(page).toHaveURL(new RegExp(`/w/${live.firstWorkspace.id}$`));
    await expect(main.getByRole('heading', { level: 1, name: live.firstWorkspace.name })).toBeVisible();
  });

  test('UI state (mocked empty list): no workspaces for the real dev actor', async ({ page }) => {
    await page.route(WORKSPACE_LIST, (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [], meta: { requestId: 'req_e2e_empty', nextCursor: null } }),
      }),
    );

    await page.goto('/');
    const main = page.getByRole('main');
    await expect(main.getByRole('heading', { level: 1, name: "No workspaces available" })).toBeVisible();
    await expect(main).toContainText(live.me.actor.displayName);
    await expect(page).toHaveURL(/\/$/);
  });
});

test.describe('mobile 390px', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('real API: content visible without page-level horizontal overflow', async ({ page }, testInfo) => {
    const { me, firstWorkspace, members } = live;
    await page.goto('/');
    await expect(page).toHaveURL(new RegExp(`/w/${firstWorkspace.id}$`));

    const main = page.getByRole('main');
    await expect(main).toBeVisible();
    await expect(main.getByRole('heading', { level: 1, name: firstWorkspace.name })).toBeVisible();
    await expect(page.getByTitle("Local mode with synthetic data", { exact: true })).toBeVisible();
    await expect(page.getByRole('complementary', { name: "Sidebar" })).toBeHidden();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath('p0-mobile-overview.png'), fullPage: true });

    await page.getByRole('button', { name: "Open menu" }).click();
    const drawer = page.getByRole('dialog', { name: "Navigation" });
    await expect(drawer.getByRole('region', { name: "Local demo" })).toContainText(
      me.actor.displayName,
    );
    await drawer.getByRole('link', { name: "Members" }).click();
    await expect(drawer).toBeHidden();

    await expect(main.getByRole('heading', { level: 1, name: "Members" })).toBeVisible();
    await expect(main.getByRole('table').getByRole('row')).toHaveCount(members.length + 1);
    await expectNoHorizontalOverflow(page);
  });
});
