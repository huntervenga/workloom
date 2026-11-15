import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppConnectionNotice, CONNECTION_PROBE_TIMEOUT_MS, CONNECTION_PROBE_URL, CONNECTION_RECHECK_MS } from './AppConnectionNotice';

const notice = "You're offline. Reconnect to load and save changes.";
let browserOnline = true;
let visibility: DocumentVisibilityState = 'visible';
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  browserOnline = true;
  visibility = 'visible';
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => browserOnline });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  vi.stubGlobal('fetch', fetchMock);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  Reflect.deleteProperty(navigator, 'onLine');
  Reflect.deleteProperty(document, 'visibilityState');
});

const settle = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const setBrowserOnline = (online: boolean) => act(() => { browserOnline = online; window.dispatchEvent(new Event(online ? 'online' : 'offline')); });
const answers = (status = 200) => () => Promise.resolve(new Response(null, { status }));
const networkError = () => Promise.reject(new TypeError('Failed to fetch'));
const noReply: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
  init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
});

it('stays hidden without asking the server while the browser reports a connection', async () => {
  render(<AppConnectionNotice />);
  await settle(CONNECTION_RECHECK_MS);
  expect(screen.queryByText(notice)).not.toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalled();
});

it('stays hidden while the browser wrongly reports offline but the server answers, even with an error status', async () => {
  fetchMock.mockImplementationOnce(answers(200)).mockImplementation(answers(503));
  render(<AppConnectionNotice />);
  await setBrowserOnline(false);
  await settle();
  expect(screen.queryByText(notice)).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith(CONNECTION_PROBE_URL, expect.objectContaining({ cache: 'no-store', credentials: 'omit' }));
  await settle(CONNECTION_RECHECK_MS);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(screen.queryByText(notice)).not.toBeInTheDocument();
});

it('shows the notice when the server cannot be reached, and hides it once a recheck gets through', async () => {
  browserOnline = false;
  fetchMock.mockImplementationOnce(networkError).mockImplementation(answers());
  render(<AppConnectionNotice />);
  await settle();
  expect(screen.getByRole('status')).toHaveTextContent(notice);
  await settle(CONNECTION_RECHECK_MS);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(screen.queryByText(notice)).not.toBeInTheDocument();
});

it('counts a probe without a reply in time as offline', async () => {
  browserOnline = false;
  fetchMock.mockImplementation(noReply);
  render(<AppConnectionNotice />);
  await settle(CONNECTION_PROBE_TIMEOUT_MS - 1);
  expect(screen.queryByText(notice)).not.toBeInTheDocument();
  await settle(1);
  expect(screen.getByText(notice)).toBeVisible();
});

it('does not ask while the app is in the background and asks again when it returns', async () => {
  browserOnline = false;
  fetchMock.mockImplementationOnce(networkError).mockImplementation(answers());
  render(<AppConnectionNotice />);
  await settle();
  expect(screen.getByText(notice)).toBeVisible();
  visibility = 'hidden';
  await act(() => { document.dispatchEvent(new Event('visibilitychange')); });
  await settle(CONNECTION_RECHECK_MS * 2);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  visibility = 'visible';
  await act(() => { document.dispatchEvent(new Event('visibilitychange')); });
  await settle();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(screen.queryByText(notice)).not.toBeInTheDocument();
});

it('hides at once and stops asking when the browser reports a connection; an old failure never flashes later', async () => {
  browserOnline = false;
  fetchMock.mockImplementationOnce(networkError).mockImplementation(noReply);
  render(<AppConnectionNotice />);
  await settle();
  expect(screen.getByText(notice)).toBeVisible();
  await setBrowserOnline(true);
  expect(screen.queryByText(notice)).not.toBeInTheDocument();
  await settle(CONNECTION_RECHECK_MS * 2);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  // The next offline report waits for its own answer before showing anything.
  await setBrowserOnline(false);
  await settle();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(screen.queryByText(notice)).not.toBeInTheDocument();
});
