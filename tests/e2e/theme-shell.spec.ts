import { expect, test, type Locator, type Page, type Request, type Response, type TestInfo } from '@playwright/test';

/**
 * Public theme shell: the prerendered landing page (/) and the anonymous app gate (/app).
 * Each case starts in a fresh context with a system color scheme, flips the theme through the
 * real toggle, and checks that the choice is applied before first paint after reload and across routes.
 * Nothing here writes theme state directly, signs in, mocks requests or follows Sign in.
 */

type Theme = 'light' | 'dark';
type Route = 'landing' | 'app';

const ROUTES: readonly Route[] = ['landing', 'app'];
const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const;
const SYSTEMS: readonly Theme[] = ['light', 'dark'];
const PATHS: Record<Route, string> = { landing: '/', app: '/app' };

const PUBLIC_CANONICAL = 'https://workloom.pavelignatov.com/';
const LANDING_TITLE = 'Workloom — Team Task Management and Weekly Planning';
const LANDING_DESCRIPTION = 'Bring tasks, weekly plans, recorded work, team meetings and dependencies into one connected workspace.';
const HERO_TITLE = 'Give every week a clear thread.';
const APP_TITLE = 'Workloom';
const TOGGLE_NAME = 'Dark theme';
const TITLE_TO_DARK = 'Switch to dark theme';
const TITLE_TO_LIGHT = 'Switch to light theme';
const SIGN_IN_NAME = 'Sign in';
const THEME_STORAGE_KEY = 'workloom.theme';

const GUEST_IDENTITY_PATH = '/api/v1/me';
const AUTH_CONFIG_PATH = '/api/v1/auth/config';
const API_LIKE_PATH = /^\/(?:api|auth)(?:\/|$)/;
const THEME_INIT_SRC = /\/theme-init\.js$/;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const LOOPBACK_ORIGIN = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/?$/;

const MIN_TEXT_CONTRAST = 4.5;
const MIN_NON_TEXT_CONTRAST = 3;
/** The public theme control must sit in the top band of the first screen. */
const TOP_BAND = 140;
const EPSILON = 0.5;

test.use({ trace: 'off', video: 'off' });

function qaOrigin(): string {
  const raw = process.env.WORKLOOM_QA_BASE_URL;
  if (!raw) throw new Error('WORKLOOM_QA_BASE_URL must be set explicitly to the private QA server (http://127.0.0.1:<port>).');
  const match = LOOPBACK_ORIGIN.exec(raw);
  const port = Number(match?.[1] ?? 0);
  if (!match || port < 1 || port > 65535) throw new Error(`WORKLOOM_QA_BASE_URL must be a loopback http://127.0.0.1:<port> origin, got ${raw}`);
  return new URL(raw).origin;
}

function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

const at = (path: string) => new URL(path, qaOrigin()).toString();
const opposite = (theme: Theme): Theme => (theme === 'dark' ? 'light' : 'dark');
const themeToggle = (page: Page) => page.getByRole('button', { name: TOGGLE_NAME, exact: true });
const signInLink = (page: Page) => page.getByRole('link', { name: SIGN_IN_NAME, exact: true });

test.beforeEach(async ({ baseURL }) => {
  const origin = qaOrigin();
  expect(baseURL, 'the root config must supply baseURL').toBeTruthy();
  const configured = requireValue(baseURL, 'the root config must supply baseURL');
  expect(new URL(configured).origin, 'baseURL must match WORKLOOM_QA_BASE_URL').toBe(origin);
});

// ---------------------------------------------------------------------------------------------
// First-frame recorder. Read-only: it never writes theme state, storage or attributes.

interface FrameState {
  dataTheme: string | null;
  inlineColorScheme: string;
  computedColorScheme: string;
  bodyPresent: boolean;
  readyState: string;
  rootChildren: number | null;
  scripts: string[];
  at: number;
}

interface ThemeShellRecord {
  firstFrame: FrameState | null;
  firstThemeMutation: FrameState | null;
  firstSchemeMutation: FrameState | null;
  domContentLoadedAt: number | null;
}

declare global {
  interface Window {
    __themeShellRecord?: ThemeShellRecord;
  }
}

/** Runs at document creation, before any page script; serialized, so it must stay self-contained. */
function recordThemeFrames() {
  const read = () => {
    const root = document.documentElement;
    const appRoot = document.getElementById('root');
    return {
      dataTheme: root ? root.getAttribute('data-theme') : null,
      inlineColorScheme: root ? root.style.colorScheme : '',
      computedColorScheme: root ? getComputedStyle(root).colorScheme : '',
      bodyPresent: document.body !== null,
      readyState: document.readyState,
      rootChildren: appRoot !== null ? appRoot.childElementCount : null,
      scripts: Array.from(document.scripts, (script) => script.getAttribute('src') ?? '(inline)'),
      at: performance.now(),
    };
  };
  const record: ThemeShellRecord = { firstFrame: null, firstThemeMutation: null, firstSchemeMutation: null, domContentLoadedAt: null };
  Object.defineProperty(window, '__themeShellRecord', { value: record, configurable: false, writable: false });
  // Registered at document creation, so this is the first rendering opportunity of this document.
  requestAnimationFrame(() => {
    record.firstFrame = read();
  });
  document.addEventListener('DOMContentLoaded', () => {
    record.domContentLoadedAt = performance.now();
  }, { once: true });
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.target !== document.documentElement) continue;
      const root = document.documentElement;
      if (mutation.attributeName === 'data-theme' && record.firstThemeMutation === null && root.hasAttribute('data-theme')) record.firstThemeMutation = read();
      if (mutation.attributeName === 'style' && record.firstSchemeMutation === null && root.style.colorScheme !== '') record.firstSchemeMutation = read();
    }
    if (record.firstThemeMutation !== null && record.firstSchemeMutation !== null) observer.disconnect();
  });
  observer.observe(document, { subtree: true, attributes: true, attributeFilter: ['data-theme', 'style'] });
}

async function expectBeforePaintTheme(page: Page, testInfo: TestInfo, theme: Theme, step: string) {
  await page.waitForFunction(() => (window.__themeShellRecord?.firstFrame ?? null) !== null);
  const record = await page.evaluate(() => window.__themeShellRecord ?? null);
  await testInfo.attach(`first-frame-${step}.json`, { body: JSON.stringify(record, null, 2), contentType: 'application/json' });
  expect(record, `${step}: the init-script recorder must be installed`).not.toBeNull();
  const { firstFrame: frame, firstThemeMutation, firstSchemeMutation } = requireValue(record, `${step}: the init-script recorder must be installed`);
  const firstFrame = requireValue(frame, `${step}: the first animation frame must be recorded`);

  expect(firstFrame.dataTheme, `${step}: data-theme at the first animation frame`).toBe(theme);
  expect(firstFrame.computedColorScheme, `${step}: computed color-scheme at the first animation frame`).toBe(theme);
  // /theme-init.js always sets the inline color-scheme right after data-theme.
  expect(firstFrame.inlineColorScheme, `${step}: inline color-scheme at the first animation frame`).toBe(theme);

  // The external bootstrap, not hydration, must write the theme: the first write happens while
  // <head> is still being parsed, right after /theme-init.js ran, and already carries the final value.
  expect(firstThemeMutation, `${step}: data-theme must be written before first paint`).not.toBeNull();
  const themeWrite = requireValue(firstThemeMutation, `${step}: data-theme must be written before first paint`);
  expect(themeWrite.dataTheme, `${step}: the first data-theme written`).toBe(theme);
  expect(themeWrite.bodyPresent, `${step}: data-theme must be set before <body> is parsed`).toBe(false);
  expect(themeWrite.scripts[themeWrite.scripts.length - 1] ?? '', `${step}: last parsed script when data-theme was first set`).toMatch(THEME_INIT_SRC);
  expect(themeWrite.at, `${step}: bootstrap must apply before the first frame`).toBeLessThanOrEqual(firstFrame.at);

  expect(firstSchemeMutation, `${step}: inline color-scheme must be written before first paint`).not.toBeNull();
  const schemeWrite = requireValue(firstSchemeMutation, `${step}: inline color-scheme must be written before first paint`);
  expect(schemeWrite.inlineColorScheme, `${step}: the first inline color-scheme written`).toBe(theme);
  expect(schemeWrite.bodyPresent, `${step}: inline color-scheme must be set before <body> is parsed`).toBe(false);
  expect(schemeWrite.at, `${step}: inline color-scheme must apply before the first frame`).toBeLessThanOrEqual(firstFrame.at);
}

// ---------------------------------------------------------------------------------------------
// Network, error and navigation observation. Observe only; nothing is routed or mocked.

interface Observer {
  phase: Route;
  pageErrors: string[];
  consoleErrors: string[];
  badResponses: string[];
  failedRequests: string[];
  mutatingRequests: string[];
  landingApiRequests: string[];
  unexpectedApiRequests: string[];
  identityStatuses: number[];
  authConfigStatuses: number[];
  foreignDocuments: string[];
  mainFrameUrls: string[];
}

function issuerOf(request: Request): Route | null {
  try {
    const path = new URL(request.frame().url()).pathname;
    if (path === '/') return 'landing';
    return path === '/app' || path.startsWith('/app/') ? 'app' : null;
  } catch {
    return null;
  }
}

function observe(page: Page, origin: string, phase: Route): Observer {
  const o: Observer = {
    phase,
    pageErrors: [],
    consoleErrors: [],
    badResponses: [],
    failedRequests: [],
    mutatingRequests: [],
    landingApiRequests: [],
    unexpectedApiRequests: [],
    identityStatuses: [],
    authConfigStatuses: [],
    foreignDocuments: [],
    mainFrameUrls: [],
  };
  const sameOriginPath = (raw: string): string | null => {
    try {
      const url = new URL(raw);
      return url.origin === origin ? url.pathname : null;
    } catch {
      return null;
    }
  };
  const isGuestIdentity = (method: string, raw: string, status: number) => method === 'GET' && sameOriginPath(raw) === GUEST_IDENTITY_PATH && status === 401;

  page.on('pageerror', (error) => o.pageErrors.push(`${error.name}: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const source = message.location().url;
    // Chrome logs the expected guest 401 as a resource error located at that exact URL.
    if (sameOriginPath(source) === GUEST_IDENTITY_PATH && /\b401\b/.test(message.text())) return;
    o.consoleErrors.push(`${message.text()} @ ${source}`);
  });
  page.on('request', (request) => {
    const method = request.method();
    const raw = request.url();
    if (!/^https?:/.test(raw)) return;
    const url = new URL(raw);
    if (!SAFE_METHODS.has(method)) o.mutatingRequests.push(`${method} ${raw}`);
    if (request.resourceType() === 'document' && url.origin !== origin) o.foreignDocuments.push(raw);
    if (url.origin !== origin || !API_LIKE_PATH.test(url.pathname)) return;
    const issuer = issuerOf(request) ?? o.phase;
    if (issuer === 'landing') o.landingApiRequests.push(`${method} ${raw}`);
    else if (method !== 'GET' || (url.pathname !== GUEST_IDENTITY_PATH && url.pathname !== AUTH_CONFIG_PATH)) o.unexpectedApiRequests.push(`${method} ${raw}`);
  });
  page.on('response', (response: Response) => {
    const method = response.request().method();
    const raw = response.url();
    const status = response.status();
    const path = sameOriginPath(raw);
    if (path === GUEST_IDENTITY_PATH) o.identityStatuses.push(status);
    if (path === AUTH_CONFIG_PATH) o.authConfigStatuses.push(status);
    if (status >= 400 && !isGuestIdentity(method, raw, status)) o.badResponses.push(`${status} ${method} ${raw}`);
  });
  page.on('requestfailed', (request) => o.failedRequests.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText ?? 'failed'}`));
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame() && frame.url() !== 'about:blank') o.mainFrameUrls.push(frame.url());
  });
  return o;
}

function expectCleanRun(o: Observer, origin: string) {
  expect(o.pageErrors, 'uncaught page errors').toEqual([]);
  expect(o.consoleErrors, 'console errors other than the guest identity 401').toEqual([]);
  expect(o.badResponses, 'HTTP errors other than GET /api/v1/me 401').toEqual([]);
  expect(o.failedRequests, 'failed requests').toEqual([]);
  expect(o.mutatingRequests, 'requests other than GET/HEAD/OPTIONS').toEqual([]);
  expect(o.landingApiRequests, 'the landing page must not call /api or /auth').toEqual([]);
  expect(o.unexpectedApiRequests, 'the guest app may only read /api/v1/me and /api/v1/auth/config').toEqual([]);
  expect(o.foreignDocuments, 'no navigation may leave the QA origin (no auth redirect)').toEqual([]);
  expect(o.identityStatuses.length, 'the guest app must read /api/v1/me').toBeGreaterThan(0);
  expect(o.identityStatuses.filter((status) => status !== 401), 'the guest identity read must answer 401').toEqual([]);
  expect(o.authConfigStatuses.length, 'the guest app must read /api/v1/auth/config').toBeGreaterThan(0);
  expect(o.authConfigStatuses.filter((status) => !((status >= 200 && status < 300) || status === 304)), 'auth config statuses').toEqual([]);
  const strays = o.mainFrameUrls.filter((raw) => {
    const url = new URL(raw);
    return url.origin !== origin || !(url.pathname === '/' || /^\/app\/?$/.test(url.pathname));
  });
  expect(strays, 'main-frame URLs outside / and /app').toEqual([]);
}

// ---------------------------------------------------------------------------------------------
// Static shell checks (DOM reads only; no auth fragment is ever navigated to).

async function expectLandingStatic(page: Page, response: Response | null) {
  expect(response?.status(), 'landing document status').toBe(200);
  expect(response?.headers()['x-robots-tag'] ?? '', 'landing must stay indexable').not.toMatch(/noindex|none/i);
  await expect(page).toHaveTitle(LANDING_TITLE);
  const shell = await page.evaluate(() => {
    const contents = (selector: string) => Array.from(document.querySelectorAll(selector), (node) => node.getAttribute('content'));
    const scripts = Array.from(document.scripts);
    return {
      lang: document.documentElement.lang,
      description: contents('meta[name="description"]'),
      canonical: Array.from(document.querySelectorAll('link[rel="canonical"]'), (node) => node.getAttribute('href')),
      ogUrl: contents('meta[property="og:url"]'),
      robots: contents('meta[name="robots"], meta[name="googlebot"]'),
      inlineScripts: scripts.filter((script) => !script.hasAttribute('src')).length,
      themeInit: scripts
        .filter((script) => /\/theme-init\.js$/.test(script.getAttribute('src') ?? ''))
        .map((script) => ({ inHead: script.parentElement === document.head, async: script.hasAttribute('async'), defer: script.hasAttribute('defer'), type: script.type })),
      moduleScripts: document.querySelectorAll('script[type="module"][src]').length,
      landingBody: document.body.classList.contains('landing'),
      h1: Array.from(document.querySelectorAll('h1'), (node) => node.textContent?.trim()),
    };
  });
  expect(shell.lang).toBe('en');
  expect(shell.description).toEqual([LANDING_DESCRIPTION]);
  expect(shell.canonical).toEqual([PUBLIC_CANONICAL]);
  expect(shell.ogUrl).toEqual([PUBLIC_CANONICAL]);
  expect(shell.robots.filter((value) => /noindex|none/i.test(value ?? '')), 'landing must stay indexable').toEqual([]);
  expect(shell.inlineScripts, 'the landing page runs no inline script').toBe(0);
  expect(shell.themeInit, 'one blocking /theme-init.js in <head>').toEqual([{ inHead: true, async: false, defer: false, type: '' }]);
  expect(shell.moduleScripts, 'the landing toggle module').toBeGreaterThan(0);
  expect(shell.landingBody).toBe(true);
  expect(shell.h1).toEqual([HERO_TITLE]);
}

async function expectAppStatic(page: Page) {
  await expect(page).toHaveTitle(APP_TITLE);
  const shell = await page.evaluate(() => {
    const following = (a: Node, b: Node) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    const scripts = Array.from(document.scripts);
    const inline = scripts.filter((script) => !script.hasAttribute('src'));
    const strip = inline[0] ?? null;
    const text = strip?.textContent ?? '';
    const themeInit = scripts.filter((script) => /\/theme-init\.js$/.test(script.getAttribute('src') ?? ''));
    const referrer = document.querySelector('meta[name="referrer"]');
    return {
      robots: Array.from(document.querySelectorAll('meta[name="robots"]'), (node) => node.getAttribute('content')),
      stripInHead: strip?.parentElement === document.head,
      stripShape: {
        callbackPath: /['"]\/app\/auth\/callback['"]/.test(text),
        readsHash: /location\.hash/.test(text),
        replacesUrl: /history\.replaceState\s*\(/.test(text),
        handoff: text.includes('__workloomTakeAuthCallback'),
        names: /access_token/.test(text) && /refresh_token/.test(text) && /['"]state['"]/.test(text),
        noSideChannels: !/localStorage|sessionStorage|document\.cookie|fetch\s*\(|XMLHttpRequest|sendBeacon/.test(text),
      },
      classicScriptsBeforeStrip: strip
        ? scripts.filter((script) => script !== strip && script.type !== 'module' && following(script, strip)).map((script) => script.getAttribute('src') ?? '(inline)')
        : ['(no inline script)'],
      referrerBeforeStrip: referrer !== null && strip !== null && referrer.getAttribute('content') === 'same-origin' && following(referrer, strip),
      themeInit: themeInit.map((script) => ({
        inHead: script.parentElement === document.head,
        afterStrip: strip !== null && following(strip, script),
        async: script.hasAttribute('async'),
        defer: script.hasAttribute('defer'),
        type: script.type,
      })),
      // Off the callback path the strip returns early and never defines the handoff.
      handoffDefined: typeof (window as Window & { __workloomTakeAuthCallback?: unknown }).__workloomTakeAuthCallback !== 'undefined',
    };
  });
  expect(shell.robots, 'the app keeps noindex').toEqual(['noindex']);
  expect(shell.stripInHead, 'the auth fragment strip is the first inline script, in <head>').toBe(true);
  expect(shell.stripShape).toEqual({ callbackPath: true, readsHash: true, replacesUrl: true, handoff: true, names: true, noSideChannels: true });
  expect(shell.classicScriptsBeforeStrip, 'no classic script may run before the fragment strip').toEqual([]);
  expect(shell.referrerBeforeStrip, 'same-origin referrer policy precedes the strip').toBe(true);
  expect(shell.themeInit, 'one blocking /theme-init.js in <head> after the strip').toEqual([{ inHead: true, afterStrip: true, async: false, defer: false, type: '' }]);
  expect(shell.handoffDefined).toBe(false);
}

async function expectGuestGate(page: Page) {
  expect(new URL(page.url()).pathname).toMatch(/^\/app\/?$/);
  await expect(page.locator('#sign-in-title')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  const link = signInLink(page);
  await expect(link).toHaveCount(1);
  await expect(link).toBeVisible();
  const href = await link.getAttribute('href');
  expect(href ?? '', 'Sign in stays a plain link').not.toBe('');
  expect(href ?? '').not.toMatch(/^\s*javascript:/i);
}

// ---------------------------------------------------------------------------------------------
// Theme state, controls, layout and readability.

async function expectToggleState(page: Page, theme: Theme) {
  const toggle = themeToggle(page);
  await expect(toggle).toHaveCount(1);
  await expect(toggle).toHaveAttribute('aria-pressed', String(theme === 'dark'));
  await expect(toggle).toHaveAttribute('title', theme === 'dark' ? TITLE_TO_LIGHT : TITLE_TO_DARK);
}

async function expectThemeApplied(page: Page, theme: Theme, stored: Theme | null) {
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await expect.poll(() => page.evaluate(() => document.documentElement.style.colorScheme), { message: 'inline color-scheme' }).toBe(theme);
  const state = await page.evaluate((key) => {
    const meta = document.querySelector('meta[name="theme-color"]');
    return {
      computed: getComputedStyle(document.documentElement).colorScheme,
      stored: localStorage.getItem(key),
      themeColor: meta?.getAttribute('content') ?? null,
      light: meta?.getAttribute('data-light') ?? null,
      dark: meta?.getAttribute('data-dark') ?? null,
    };
  }, THEME_STORAGE_KEY);
  expect(state.computed, 'computed color-scheme').toBe(theme);
  expect(state.stored, 'stored choice').toBe(stored);
  expect(state.themeColor, 'theme-color follows its own data-* value').toBe(state[theme]);
  await expectToggleState(page, theme);
}

async function settle(page: Page, route: Route) {
  if (route === 'app') {
    await expect(signInLink(page)).toBeVisible();
  } else {
    await expect(themeToggle(page)).toBeVisible();
  }
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

async function settleAnimations(page: Page) {
  await page.mouse.move(1, 1);
  await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== 'running'));
}

interface Geometry {
  left: number;
  top: number;
  right: number;
  bottom: number;
  hit: boolean;
  viewportWidth: number;
  viewportHeight: number;
}

function geometry(locator: Locator): Promise<Geometry> {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      hit: hit !== null && (hit === element || element.contains(hit)),
      viewportWidth: document.documentElement.clientWidth,
      viewportHeight: window.innerHeight,
    };
  });
}

function rootControls(page: Page, route: Route): Array<[string, Locator]> {
  if (route === 'app') return [['theme toggle', themeToggle(page)], ['Sign in link', signInLink(page)]];
  const banner = page.getByRole('banner');
  const nav = page.getByRole('navigation', { name: 'Main navigation', exact: true });
  const hero = page.getByRole('region', { name: HERO_TITLE, exact: true });
  return [
    ['theme toggle', themeToggle(page)],
    ['header brand', banner.getByRole('link', { name: 'Workloom', exact: true })],
    ['nav Features', nav.getByRole('link', { name: 'Features', exact: true })],
    ['nav How it works', nav.getByRole('link', { name: 'How it works', exact: true })],
    ['header Open app', banner.getByRole('link', { name: 'Open app', exact: true })],
    ['hero Open app', hero.getByRole('link', { name: 'Open app', exact: true })],
    ['hero See how it works', hero.getByRole('link', { name: 'See how it works', exact: true })],
  ];
}

async function expectLayout(page: Page, route: Route, step: string) {
  await page.evaluate(() => window.scrollTo(0, 0));
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth, `${step}: no horizontal page overflow`).toBeLessThanOrEqual(overflow.clientWidth);
  expect(overflow.bodyScrollWidth, `${step}: no horizontal body overflow`).toBeLessThanOrEqual(overflow.clientWidth);

  const toggle = themeToggle(page);
  await expect(toggle).toBeVisible();
  await expect(toggle).toBeEnabled();
  const top = await geometry(toggle);
  expect(top.left, `${step}: toggle inside the viewport`).toBeGreaterThanOrEqual(-EPSILON);
  expect(top.right, `${step}: toggle inside the viewport`).toBeLessThanOrEqual(top.viewportWidth + EPSILON);
  expect(top.top, `${step}: toggle inside the viewport`).toBeGreaterThanOrEqual(-EPSILON);
  expect(top.bottom, `${step}: toggle in the top band`).toBeLessThanOrEqual(TOP_BAND);
  expect((top.left + top.right) / 2, `${step}: toggle on the right`).toBeGreaterThan(top.viewportWidth / 2);
  expect(top.hit, `${step}: toggle is not covered`).toBe(true);
  await toggle.focus();
  await expect(toggle).toBeFocused();
  await toggle.blur();

  for (const [label, control] of rootControls(page, route)) {
    await expect(control, `${step}: ${label}`).toHaveCount(1);
    await expect(control, `${step}: ${label}`).toBeVisible();
    await control.scrollIntoViewIfNeeded();
    const box = await geometry(control);
    expect(box.left, `${step}: ${label} left edge`).toBeGreaterThanOrEqual(-EPSILON);
    expect(box.right, `${step}: ${label} right edge`).toBeLessThanOrEqual(box.viewportWidth + EPSILON);
    expect(box.top, `${step}: ${label} top edge`).toBeGreaterThanOrEqual(-EPSILON);
    expect(box.bottom, `${step}: ${label} bottom edge`).toBeLessThanOrEqual(box.viewportHeight + EPSILON);
    expect(box.hit, `${step}: ${label} receives the pointer at its center`).toBe(true);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}

interface ReadabilitySample {
  label: string;
  found: boolean;
  min: number;
  /** Unrounded; the only value compared against min. */
  ratio: number;
  /** Rounded copy of ratio for the attached report only. */
  displayRatio: number;
  fg: number[];
  bg: number[];
  fontSize: string;
  backgroundImages: string[];
  /** Nearest ancestor-or-self with an opaque computed background-color; '' when there is none. */
  backdrop: string;
  opacity: number;
}

/**
 * Contrast from actual computed colors, compositing translucent backgrounds over the nearest opaque
 * computed background-color. Without one the sample is rejected (found: false) instead of assuming the
 * UA canvas color. Background images between the text and that backdrop are reported, not composited.
 */
function measureReadability(page: Page, route: Route, textMin: number, nonTextMin: number): Promise<ReadabilitySample[]> {
  return page.evaluate(({ route, textMin, nonTextMin }) => {
    type RGBA = [number, number, number, number];
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('2d canvas unavailable');
    // Normalizes any computed color syntax (rgb, oklch, color()) to sRGB bytes.
    const toRgba = (css: string): RGBA => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = 'rgba(0, 0, 0, 0)';
      context.fillStyle = css;
      context.fillRect(0, 0, 1, 1);
      // A missing channel reads as transparent black, which never counts as an opaque backdrop.
      const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    const over = (top: RGBA, bottom: RGBA): RGBA => [
      top[0] * top[3] + bottom[0] * (1 - top[3]),
      top[1] * top[3] + bottom[1] * (1 - top[3]),
      top[2] * top[3] + bottom[2] * (1 - top[3]),
      1,
    ];
    const channel = (value: number) => {
      const c = value / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (c: RGBA) => 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
    const contrast = (a: RGBA, b: RGBA) => {
      const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      if (high === undefined || low === undefined) throw new Error('contrast needs two luminances');
      return (high + 0.05) / (low + 0.05);
    };
    const name = (node: Element) => `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}${node.classList.length ? `.${Array.from(node.classList).join('.')}` : ''}`;

    const sample = (label: string, element: Element | null | undefined, min: number, needsText = true) => {
      if (!element) return { label, found: false, min, ratio: 0, displayRatio: 0, fg: [], bg: [], fontSize: '', backgroundImages: [], backdrop: '', opacity: 0 };
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && (!needsText || (element.textContent ?? '').trim().length > 0);
      // Layers from the element outwards, ending at the first opaque one; anything behind it is hidden.
      const layers: RGBA[] = [];
      const backgroundImages: string[] = [];
      let backdrop = '';
      let opacity = 1;
      for (let node: Element | null = element; node; node = node.parentElement) {
        const nodeStyle = getComputedStyle(node);
        opacity *= Number.parseFloat(nodeStyle.opacity);
        if (backdrop !== '') continue;
        const layer = toRgba(nodeStyle.backgroundColor);
        layers.push(layer);
        if (nodeStyle.backgroundImage !== 'none') backgroundImages.push(name(node));
        if (layer[3] >= 1) backdrop = name(node);
      }
      const base = layers[layers.length - 1];
      // No opaque computed background: the UA canvas color is not observable here, so reject the sample.
      if (backdrop === '' || base === undefined) {
        return { label, found: false, min, ratio: 0, displayRatio: 0, fg: [], bg: [], fontSize: style.fontSize, backgroundImages, backdrop, opacity };
      }
      let bg: RGBA = base;
      for (let index = layers.length - 2; index >= 0; index -= 1) {
        const layer = layers[index];
        if (layer === undefined) throw new Error(`${label}: missing background layer ${index}`);
        bg = over(layer, bg);
      }
      const text = toRgba(style.color);
      const fg = over([text[0], text[1], text[2], text[3] * opacity], bg);
      const ratio = contrast(fg, bg);
      return { label, found: visible, min, ratio, displayRatio: Math.round(ratio * 100) / 100, fg: fg.map(Math.round), bg: bg.map(Math.round), fontSize: style.fontSize, backgroundImages, backdrop, opacity };
    };

    const query = (selector: string) => document.querySelector(selector);
    if (route === 'landing') {
      const hero = query('section.hero');
      return [
        sample('body text on page canvas', document.body, textMin),
        sample('header brand', query('header.site-header .brand'), textMin),
        ...Array.from(document.querySelectorAll('header.site-header nav a'), (link) => sample(`header nav "${link.textContent?.trim()}"`, link, textMin)),
        sample('header Open app action', query('header.site-header a.button-primary'), textMin),
        sample('hero eyebrow', hero?.querySelector('.eyebrow'), textMin),
        sample('hero heading', query('#hero-title'), textMin),
        sample('hero description', hero?.querySelector('.hero-description'), textMin),
        sample('hero Open app action', hero?.querySelector('.hero-actions a.button-primary'), textMin),
        sample('hero secondary action', hero?.querySelector('.hero-actions a.text-link'), textMin),
        sample('hero note', hero?.querySelector('.hero-note'), textMin),
        sample('theme toggle icon (non-text)', query('button[data-theme-toggle]'), nonTextMin, false),
      ];
    }
    const title = query('#sign-in-title');
    const section = title?.closest('section');
    const frame = section?.parentElement;
    return [
      sample('body text on page canvas', document.body, textMin),
      sample('gate brand', frame?.querySelector(':scope > div:first-child > span'), textMin),
      sample('sign-in heading', title, textMin),
      sample('sign-in description', section?.querySelector('p'), textMin),
      sample('Sign in action', section?.querySelector('a[href]'), textMin),
      sample('theme toggle icon (non-text)', query('button[aria-label="Dark theme"]'), nonTextMin, false),
    ];
  }, { route, textMin, nonTextMin });
}

async function expectReadable(page: Page, testInfo: TestInfo, route: Route, step: string) {
  const samples = await measureReadability(page, route, MIN_TEXT_CONTRAST, MIN_NON_TEXT_CONTRAST);
  await testInfo.attach(`readability-${step}.json`, { body: JSON.stringify(samples, null, 2), contentType: 'application/json' });
  const onImages = samples.filter((sample) => sample.backgroundImages.length > 0).map((sample) => `${sample.label}: ${sample.backgroundImages.join(', ')}`);
  expect(onImages, `${step}: sampled text must not sit on a background image (gradients are not composited)`).toEqual([]);
  const failures = samples.filter((sample) => !sample.found || sample.ratio < sample.min);
  expect(failures, `${step}: core text must reach its contrast minimum`).toEqual([]);
}

async function captureTheme(page: Page, testInfo: TestInfo, route: Route, step: string, name: string) {
  await settleAnimations(page);
  await expectLayout(page, route, step);
  await expectReadable(page, testInfo, route, step);
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });
}

// ---------------------------------------------------------------------------------------------

for (const route of ROUTES) {
  for (const viewport of VIEWPORTS) {
    for (const system of SYSTEMS) {
      test.describe(`${route} at ${viewport.width}px, system ${system}`, () => {
        test.use({ viewport, colorScheme: system });

        test('applies, toggles and persists the theme before first paint', async ({ page }, testInfo) => {
          const origin = qaOrigin();
          const chosen = opposite(system);
          const other: Route = route === 'landing' ? 'app' : 'landing';
          const label = `${route}-${viewport.width}-system-${system}`;
          const observer = observe(page, origin, route);
          await page.addInitScript(recordThemeFrames);

          // 1. Fresh context: the system preference decides, nothing is stored.
          const response = await page.goto(at(PATHS[route]));
          await settle(page, route);
          expect(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches), 'context color scheme').toBe(system === 'dark');
          await expectBeforePaintTheme(page, testInfo, system, 'initial');
          if (route === 'landing') {
            await expectLandingStatic(page, response);
          } else {
            await expectAppStatic(page);
            await expectGuestGate(page);
          }
          await expectThemeApplied(page, system, null);
          await captureTheme(page, testInfo, route, `initial-${system}`, `${label}-${system}`);

          // 2. The real toggle switches to the opposite theme.
          await themeToggle(page).click();
          await expectThemeApplied(page, chosen, chosen);
          await captureTheme(page, testInfo, route, `toggled-${chosen}`, `${label}-${chosen}`);

          // 3. The choice beats the system preference before the first frame after reload.
          await page.reload();
          await settle(page, route);
          await expectBeforePaintTheme(page, testInfo, chosen, 'reload');
          await expectThemeApplied(page, chosen, chosen);
          if (route === 'app') await expectGuestGate(page);

          // 4. And carries across the landing/app boundary.
          observer.phase = other;
          if (route === 'landing') {
            await page.getByRole('banner').getByRole('link', { name: 'Open app', exact: true }).click();
            await page.waitForURL((url) => /^\/app\/?$/.test(url.pathname));
          } else {
            await page.goto(at(PATHS.landing));
          }
          await settle(page, other);
          await expectBeforePaintTheme(page, testInfo, chosen, `cross-route-${other}`);
          await expectThemeApplied(page, chosen, chosen);
          await settleAnimations(page);
          await expectLayout(page, other, `cross-route-${other}`);
          if (other === 'app') await expectGuestGate(page);

          expectCleanRun(observer, origin);
        });
      });
    }
  }
}
