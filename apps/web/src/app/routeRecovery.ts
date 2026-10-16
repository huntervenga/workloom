/** A changed, validated built entry is evidence of an update; failed checks prove nothing. */
export type AppUpdate = 'updated' | 'unchanged' | 'unknown';
const PROBE_TIMEOUT_MS = 3_000;
const MAX_HTML_BYTES = 128 * 1024;

function builtEntry(page: Document, pageUrl: URL): string | null {
  const scripts = page.querySelectorAll('script[type="module"][src]');
  if (scripts.length !== 1 || !page.getElementById('root')) return null;
  const source = scripts[0]?.getAttribute('src');
  if (!source) return null;
  try {
    const entry = new URL(source, pageUrl);
    if (entry.origin !== pageUrl.origin || entry.username || entry.password || entry.search || entry.hash
      || !/^\/assets\/index-[a-zA-Z0-9_-]+\.js$/.test(entry.pathname)) return null;
    return entry.href;
  } catch { return null; }
}

/** Read inert HTML only: never import its entry or navigate. Stop on timeout, departure or overflow. */
export async function probeAppUpdate(page: Document, href: string, signal: AbortSignal): Promise<AppUpdate> {
  if (signal.aborted) return 'unknown';
  let pageUrl: URL;
  try { pageUrl = new URL(href); } catch { return 'unknown'; }
  if (pageUrl.protocol !== 'http:' && pageUrl.protocol !== 'https:') return 'unknown';
  const previous = builtEntry(page, pageUrl);
  if (previous === null) return 'unknown';
  // Query state is unnecessary for reading the app entry. Keep it out of the probe request.
  pageUrl.search = '';
  pageUrl.hash = '';
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, PROBE_TIMEOUT_MS);
  const cancelled = new Promise<AppUpdate>(resolve => {
    controller.signal.addEventListener('abort', () => resolve('unknown'), { once: true });
  });
  const inspect = async (): Promise<AppUpdate> => {
    const response = await fetch(pageUrl.href, {
      method: 'GET', cache: 'no-store', credentials: 'same-origin', mode: 'same-origin', redirect: 'error',
      headers: { Accept: 'text/html' }, signal: controller.signal,
    });
    if (!response.ok || response.redirected || !response.url
      || new URL(response.url).origin !== pageUrl.origin
      || response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'text/html') return 'unknown';
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_HTML_BYTES)) return 'unknown';
    if (!response.body) return 'unknown';
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let html = '', bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (controller.signal.aborted) return 'unknown';
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_HTML_BYTES) return 'unknown';
        html += decoder.decode(chunk.value, { stream: true });
      }
      html += decoder.decode();
    } finally {
      void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    const next = builtEntry(new DOMParser().parseFromString(html, 'text/html'), new URL(response.url));
    return next === null ? 'unknown' : next === previous ? 'unchanged' : 'updated';
  };
  try { return await Promise.race([inspect().catch(() => 'unknown' as const), cancelled]); }
  finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    controller.abort();
  }
}

/** Explicit user action only. The global guard's beforeunload protects actual retained input. */
export function reloadCurrentTab(): void { window.location.reload(); }
