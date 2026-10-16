import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeAppUpdate } from './routeRecovery';

const href = 'https://workloom.example/w/one/projects/two/week?worker=person&period=week#time';
const html = (entry: string) => `<!doctype html><html><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`;
const retained = () => new DOMParser().parseFromString(html('/assets/index-old123.js'), 'text/html');
function response(body: string, options: ResponseInit = {}, url = 'https://workloom.example/w/one/projects/two/week') {
  const value = new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' }, ...options });
  Object.defineProperty(value, 'url', { value: url });
  return value;
}
const signal = () => new AbortController().signal;
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('bounded app entry comparison', () => {
  it('confirms an update only from a changed built same-origin entry, using a read without query state', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(html('/assets/index-new456.js')));
    vi.stubGlobal('fetch', fetcher);
    expect(await probeAppUpdate(retained(), href, signal())).toBe('updated');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith('https://workloom.example/w/one/projects/two/week', expect.objectContaining({
      method: 'GET', cache: 'no-store', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', headers: { Accept: 'text/html' },
    }));
    expect(fetcher.mock.calls[0]?.[1].signal.aborted).toBe(true);
  });

  it('recognizes an unchanged entry even when its HTML spelling is absolute', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(html('https://workloom.example/assets/index-old123.js'))));
    expect(await probeAppUpdate(retained(), href, signal())).toBe('unchanged');
  });

  it.each([
    ['non-HTML response', () => response(html('/assets/index-new456.js'), { headers: { 'content-type': 'application/json' } })],
    ['HTTP failure', () => response(html('/assets/index-new456.js'), { status: 503 })],
    ['cross-origin response', () => response(html('/assets/index-new456.js'), {}, 'https://other.example/week')],
    ['cross-origin entry', () => response(html('https://other.example/assets/index-new456.js'))],
    ['entry with credentials', () => response(html('https://user:password@workloom.example/assets/index-new456.js'))],
    ['non-built entry', () => response(html('/src/main.tsx'))],
    ['entry with query', () => response(html('/assets/index-new456.js?different'))],
    ['entry with fragment', () => response(html('/assets/index-new456.js#different'))],
    ['missing entry', () => response('<html><div id="root"></div></html>')],
    ['missing app root', () => response('<script type="module" src="/assets/index-new456.js"></script>')],
    ['ambiguous entries', () => response(html('/assets/index-new456.js') + '<script type="module" src="/assets/index-extra.js"></script>')],
    ['oversized declared body', () => response(html('/assets/index-new456.js'), { headers: { 'content-type': 'text/html', 'content-length': '131073' } })],
    ['invalid declared length', () => response(html('/assets/index-new456.js'), { headers: { 'content-type': 'text/html', 'content-length': 'invalid' } })],
    ['redirected response', () => { const result = response(html('/assets/index-new456.js')); Object.defineProperty(result, 'redirected', { value: true }); return result; }],
  ])('keeps %s unknown', async (_name, makeResponse) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResponse()));
    expect(await probeAppUpdate(retained(), href, signal())).toBe('unknown');
  });

  it('does not fetch if the retained entry cannot establish a built version or departure already began', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const devPage = new DOMParser().parseFromString(html('/src/main.tsx'), 'text/html');
    expect(await probeAppUpdate(devPage, href, signal())).toBe('unknown');
    const departed = new AbortController(); departed.abort();
    expect(await probeAppUpdate(retained(), href, departed.signal)).toBe('unknown');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('treats network failure as unknown without exposing the error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('private transport detail')));
    expect(await probeAppUpdate(retained(), href, signal())).toBe('unknown');
  });

  it('caps actual response bytes and cancels the stream even without a trustworthy Content-Length', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(131073)); }, cancel });
    const result = new Response(body, { headers: { 'content-type': 'text/html' } });
    Object.defineProperty(result, 'url', { value: href });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(result));
    expect(await probeAppUpdate(retained(), href, signal())).toBe('unknown');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('settles and aborts after three seconds even if fetch does not honor cancellation', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockImplementation(() => new Promise<Response>(() => undefined));
    vi.stubGlobal('fetch', fetcher);
    const pending = probeAppUpdate(retained(), href, signal());
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await pending).toBe('unknown');
    expect(fetcher.mock.calls[0]?.[1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('settles immediately and aborts the request when the route leaves', async () => {
    const fetcher = vi.fn().mockImplementation(() => new Promise<Response>(() => undefined));
    vi.stubGlobal('fetch', fetcher);
    const departure = new AbortController();
    const pending = probeAppUpdate(retained(), href, departure.signal);
    departure.abort();
    expect(await pending).toBe('unknown');
    expect(fetcher.mock.calls[0]?.[1].signal.aborted).toBe(true);
  });
});
