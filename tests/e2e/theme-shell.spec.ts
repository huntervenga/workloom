import { expect, test, type Page } from '@playwright/test';

/**
 * Anonymous pages use Default (the system palette). Account preferences are tested through
 * the authenticated profile flow; public pages have no theme toggle or local theme preference.
 * These checks never sign in, mock identity, or write API data.
 */
type Scheme = 'light' | 'dark';
const viewports = [{ width: 1440, height: 900 }, { width: 390, height: 844 }] as const;
const schemes: readonly Scheme[] = ['light', 'dark'];
const paths = ['/', '/app'] as const;
const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);

test.use({ trace: 'off', video: 'off' });

function qaOrigin(): string {
  const raw = process.env.WORKLOOM_QA_BASE_URL ?? '';
  const match = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/?$/.exec(raw);
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) {
    throw new Error('WORKLOOM_QA_BASE_URL must explicitly identify a private loopback QA server.');
  }
  return new URL(raw).origin;
}

test.beforeEach(async ({ baseURL, request }) => {
  expect(baseURL && new URL(baseURL).origin).toBe(qaOrigin());
  // Fail before navigation if this is a developer identity or an authenticated context.
  expect((await request.get(`${qaOrigin()}/api/v1/me`)).status()).toBe(401);
});

async function expectDefault(page: Page, scheme: Scheme) {
  await expect(page.locator('html')).toHaveAttribute('data-theme', scheme === 'dark' ? 'default-dark' : 'light');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe(scheme);
  expect(await page.evaluate(() => localStorage.getItem('workloom.theme'))).toBeNull();
  await expect(page.getByRole('button', { name: 'Dark theme', exact: true })).toHaveCount(0);
  await expect(page.locator('[data-theme-toggle]')).toHaveCount(0);
}

for (const path of paths) {
  for (const viewport of viewports) {
    for (const scheme of schemes) {
      test.describe(`${path} at ${viewport.width}px, system ${scheme}`, () => {
        test.use({ viewport, colorScheme: scheme });
        test('follows the system on load, live changes, reload and route changes', async ({ page }) => {
          const writes: string[] = [], errors: string[] = [];
          page.on('request', request => {
            if (!safeMethods.has(request.method())) writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
          });
          page.on('pageerror', error => errors.push(error.message));
          // Observe the parser-time theme without altering application state.
          await page.addInitScript(() => {
            document.addEventListener('DOMContentLoaded', () => {
              Object.defineProperty(window, '__initialTheme', { value: document.documentElement.dataset.theme });
            }, { once: true });
          });
          const response = await page.goto(`${qaOrigin()}${path}`);
          expect(response?.status()).toBe(200);
          await expectDefault(page, scheme);
          expect(await page.evaluate(() => (window as Window & { __initialTheme?: string }).__initialTheme)).toBe(scheme === 'dark' ? 'default-dark' : 'light');
          await expect(page).toHaveTitle(/Workloom/);
          if (path === '/app') await expect(page.getByRole('heading', { name: 'Sign in to Workloom' })).toBeVisible();
          else await expect(page.locator('h1')).toBeVisible();
          // The hydrated page must continue following a changed OS preference.
          const next: Scheme = scheme === 'light' ? 'dark' : 'light';
          await page.emulateMedia({ colorScheme: next });
          await expectDefault(page, next);
          await page.reload();
          await expectDefault(page, next);
          await page.goto(`${qaOrigin()}${path === '/' ? '/app' : '/'}`);
          await expectDefault(page, next);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          expect(writes).toEqual([]);
          expect(errors).toEqual([]);
        });
      });
    }
  }
}
