// Private-QA diagnostics only. Passive observations; no credentials, payloads, polling or retries.
import type { ConsoleMessage, Frame, Page, Request, Response } from '@playwright/test';

const APP_ORIGIN = 'http://127.0.0.1:49318';
const PROVIDER_ORIGIN = 'http://127.0.0.1:49319';
const ESCAPE_MARKER = '__workloom_private_escape_diagnostic__:';
const PANE_MARKER = '__workloom_private_pane_diagnostic__:';
const PENDING_MS = 5_000;
const MAX_NETWORK_EVENTS = 250;
const COUNTERS = ['logins', 'completedLogins', 'refreshes', 'refreshRejects', 'logouts', 'meReads', 'jwksReads'] as const;
type Counter = typeof COUNTERS[number];
type StatsReader = () => Readonly<Partial<Record<Counter, number>>>;
export type PrivateBrowserPhase =
  | 'diagnostics.install' | 'auth.goto' | 'auth.sign-in' | 'auth.chooser-visible'
  | 'auth.identity-click' | 'auth.final-document' | 'auth.sign-out' | 'auth.me-read' | 'auth.session-verified'
  | 'timeline.bar-open' | 'timeline.pane-visible' | 'timeline.focus' | 'timeline.escape'
  | 'timeline.pane-closed' | 'timeline.keyboard-focus' | 'timeline.keyboard-open' | 'timeline.keyboard-visible';
type PrivateLocation = { origin: typeof APP_ORIGIN | typeof PROVIDER_ORIGIN; pathname: string };
interface State {
  started: number;
  stats: StatsReader | undefined;
  location: PrivateLocation | undefined;
  networkEvents: number;
  detach: () => void;
}
const states = new WeakMap<Page, State>();

function requirePrivateQa(): void {
  if (process.env.WORKLOOM_QA_RUN_AUTHORIZED !== '1' || process.env.WORKLOOM_QA_BASE_URL !== APP_ORIGIN) {
    throw new Error('Private browser diagnostics require authorized QA49318.');
  }
}
function privateLocation(raw: string): PrivateLocation | undefined {
  try {
    const url = new URL(raw);
    if (url.username || url.password || (url.origin !== APP_ORIGIN && url.origin !== PROVIDER_ORIGIN)) return undefined;
    return { origin: url.origin, pathname: url.pathname };
  } catch { return undefined; }
}
function errorName(error: unknown): string {
  const allowed = ['Error', 'TimeoutError', 'TypeError', 'RangeError', 'SyntaxError', 'TargetClosedError'];
  return error instanceof Error && allowed.includes(error.name) ? error.name : 'Error';
}
function snapshotStats(state: State): Partial<Record<Counter, number>> {
  const safe: Partial<Record<Counter, number>> = {};
  try {
    const values = state.stats?.();
    for (const name of COUNTERS) {
      const value = values?.[name];
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) safe[name] = value;
    }
  } catch { /* A diagnostic observer must not change the test result. */ }
  return safe;
}
function emit(state: State, event: string, details: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ diagnostic: 'private-browser', event, elapsedMs: Math.round(performance.now() - state.started), ...details }));
}
function emitNetwork(state: State, event: string, details: Record<string, unknown>): void {
  state.networkEvents += 1;
  if (state.networkEvents <= MAX_NETWORK_EVENTS) emit(state, event, details);
  else if (state.networkEvents === MAX_NETWORK_EVENTS + 1) emit(state, 'network_event_limit');
}

/** Exactly one pending marker; no timeout change, retry, browser polling or substituted action. */
export async function privateBrowserPhase<T>(page: Page, phase: PrivateBrowserPhase, action: () => Promise<T>): Promise<T> {
  requirePrivateQa();
  const state = states.get(page);
  if (!state) throw new Error('Private browser diagnostics must be attached before a phase.');
  const started = performance.now();
  emit(state, 'phase_begin', { phase, location: state.location, counters: snapshotStats(state) });
  const pending = setTimeout(() => {
    emit(state, 'phase_pending', { phase, durationMs: Math.round(performance.now() - started), location: state.location, counters: snapshotStats(state) });
  }, PENDING_MS);
  pending.unref();
  try {
    const result = await action();
    emit(state, 'phase_end', { phase, outcome: 'fulfilled', durationMs: Math.round(performance.now() - started), location: state.location, counters: snapshotStats(state) });
    return result;
  } catch (error) {
    emit(state, 'phase_end', { phase, outcome: 'rejected', errorName: errorName(error), durationMs: Math.round(performance.now() - started), location: state.location, counters: snapshotStats(state) });
    throw error;
  } finally { clearTimeout(pending); }
}

/** Call before the first private navigation; the capture listener observes Escape without handling it. */
export async function attachPrivateBrowserDiagnostics(page: Page, stats?: StatsReader): Promise<() => void> {
  requirePrivateQa();
  const existing = states.get(page);
  if (existing) { if (stats) existing.stats = stats; return existing.detach; }
  const current = page.url();
  if (current !== 'about:blank' && !privateLocation(current)) throw new Error('Diagnostics cannot attach outside private QA.');
  const state: State = { started: performance.now(), stats, location: privateLocation(current), networkEvents: 0, detach: () => {} };
  const starts = new WeakMap<Request, number>();
  const request = (req: Request) => {
    const location = privateLocation(req.url());
    if (!location) return;
    starts.set(req, performance.now());
    emitNetwork(state, 'request', { ...location, method: req.method() });
  };
  const response = (res: Response) => {
    const location = privateLocation(res.url());
    if (!location) return;
    const req = res.request(), started = starts.get(req);
    emitNetwork(state, 'response', { ...location, method: req.method(), status: res.status(), ...(started === undefined ? {} : { durationMs: Math.round(performance.now() - started) }) });
  };
  const failed = (req: Request) => {
    const location = privateLocation(req.url());
    if (!location) return;
    // Chromium's fixed error code is safe; never forward an arbitrary failure message.
    const code = /^net::(ERR_[A-Z0-9_]+)$/.exec(req.failure()?.errorText ?? '')?.[1];
    emitNetwork(state, 'request_failed', { ...location, method: req.method(), errorName: code ?? 'RequestFailure' });
  };
  const navigated = (frame: Frame) => {
    if (frame !== page.mainFrame()) return;
    state.location = privateLocation(frame.url());
    if (state.location) emit(state, 'main_frame', { ...state.location });
  };
  const dom = () => { if (state.location) emit(state, 'dom_content_loaded', { ...state.location }); };
  const load = () => { if (state.location) emit(state, 'load', { ...state.location }); };
  const crash = () => emit(state, 'page_crash', { location: state.location, counters: snapshotStats(state) });
  const close = () => { emit(state, 'page_close', { location: state.location, counters: snapshotStats(state) }); state.detach(); };
  const consoleEvent = (message: ConsoleMessage) => {
    if (state.location?.origin !== APP_ORIGIN || message.type() !== 'debug') return;
    const text = message.text();
    const marker = text.startsWith(ESCAPE_MARKER) ? ESCAPE_MARKER : text.startsWith(PANE_MARKER) ? PANE_MARKER : undefined;
    if (!marker) return;
    try {
      const value: unknown = JSON.parse(text.slice(marker.length));
      if (value === null || typeof value !== 'object') return;
      const data = value as Record<string, unknown>;
      if (marker === ESCAPE_MARKER) {
        if (typeof data['isTrusted'] !== 'boolean' || typeof data['defaultPrevented'] !== 'boolean' || typeof data['paneOpen'] !== 'boolean') return;
        emit(state, 'escape_captured', { isTrusted: data['isTrusted'], defaultPrevented: data['defaultPrevented'], paneOpen: data['paneOpen'] });
      } else {
        if (typeof data['panePresent'] !== 'boolean' || typeof data['paneOpen'] !== 'boolean' || typeof data['paneClosed'] !== 'boolean' || typeof data['taskQueryPresent'] !== 'boolean') return;
        emit(state, 'pane_state', { panePresent: data['panePresent'], paneOpen: data['paneOpen'], paneClosed: data['paneClosed'], taskQueryPresent: data['taskQueryPresent'] });
      }
    } catch { /* Ignore every nonconforming console payload, without logging it. */ }
  };
  state.detach = () => {
    page.off('request', request); page.off('response', response); page.off('requestfailed', failed);
    page.off('framenavigated', navigated); page.off('domcontentloaded', dom); page.off('load', load);
    page.off('crash', crash); page.off('close', close); page.off('console', consoleEvent);
    states.delete(page);
  };
  states.set(page, state);
  page.on('request', request); page.on('response', response); page.on('requestfailed', failed);
  page.on('framenavigated', navigated); page.on('domcontentloaded', dom); page.on('load', load);
  page.on('crash', crash); page.on('close', close); page.on('console', consoleEvent);
  try {
    await privateBrowserPhase(page, 'diagnostics.install', () => page.addInitScript(({ appOrigin, escapeMarker, paneMarker }) => {
      if (window.location.origin !== appOrigin) return;
      window.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        console.debug(escapeMarker + JSON.stringify({ isTrusted: event.isTrusted, defaultPrevented: event.defaultPrevented, paneOpen: document.querySelector('[data-task-panel][data-state="open"]') !== null }));
      }, { capture: true });
      // DOM mutations only: no timer, polling, history patch or synthetic UI event.
      // The query is inspected for presence only; no value or URL is serialized.
      let previousPaneState: string | undefined;
      const observePane = () => {
        const snapshot = JSON.stringify({
          panePresent: document.querySelector('[data-task-panel]') !== null,
          paneOpen: document.querySelector('[data-task-panel][data-state="open"]') !== null,
          paneClosed: document.querySelector('[data-task-panel][data-state="closed"]') !== null,
          taskQueryPresent: new URL(window.location.href).searchParams.has('task'),
        });
        if (snapshot === previousPaneState) return;
        previousPaneState = snapshot;
        console.debug(paneMarker + snapshot);
      };
      new MutationObserver(observePane).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-state'] });
      observePane();
    }, { appOrigin: APP_ORIGIN, escapeMarker: ESCAPE_MARKER, paneMarker: PANE_MARKER }));
  } catch (error) { state.detach(); throw error; }
  return state.detach;
}
