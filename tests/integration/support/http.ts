// Minimal HTTP client on node:http. Unlike fetch, it sends exactly the Host and Origin
// headers a test asks for, which the runtime Host/Origin guard tests need.
import { request as httpRequest } from 'node:http';

export interface RawResponse {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: Buffer;
  text(): string;
  json(): unknown;
}

export interface RawRequestOptions {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

export function rawRequest(baseUrl: string, path: string, options: RawRequestOptions = {}): Promise<RawResponse> {
  const target = new URL(path, baseUrl);
  const headers: Record<string, string> = { ...options.headers };
  if (options.body !== undefined) headers['content-length'] = String(Buffer.byteLength(options.body));

  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: options.method ?? 'GET',
        // setHost: false so an explicit `host` header is sent verbatim (forged-Host tests).
        setHost: !Object.keys(headers).some((name) => name.toLowerCase() === 'host'),
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
            text: () => body.toString('utf8'),
            json: () => JSON.parse(body.toString('utf8')) as unknown,
          });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

export function header(response: RawResponse, name: string): string {
  const value = response.headers[name.toLowerCase()];
  return Array.isArray(value) ? value.join(', ') : (value ?? '');
}
