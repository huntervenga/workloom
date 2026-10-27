import { createHash } from 'node:crypto';
import { type Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { MAX_ATTACHMENT_BYTES, attachmentMedia, type AttachmentDownload, type AttachmentMedia, type AttachmentPreview } from '@workloom/contracts';
import { temporarilyUnavailableError, type AttachmentRecord } from '@workloom/domain';
import { HttpError } from '../http/errors.js';
import type { AttachmentS3Settings } from './config.js';

export interface AttachmentStorage {
  readonly storageId: string;
  upload(row: AttachmentRecord, source: Readable, signal: AbortSignal): Promise<{ checksum: string; versionId: string | null }>;
  signDownload(row: AttachmentRecord): Promise<AttachmentDownload>;
  signPreview(row: AttachmentRecord): Promise<AttachmentPreview>;
  invalidate(objectKey: string): void;
  remove(objectKey: string, versionId: string | null): Promise<void>;
  close(): void;
}
export function downloadDisposition(fileName: string): string {
  const encoded = encodeURIComponent(fileName).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="download"; filename*=UTF-8''${encoded}`;
}
/** Bounded memory-only cache. Authorization must happen in the application BEFORE calling get(). */
export class SignedDownloadCache {
  readonly #entries = new Map<string, { value: AttachmentDownload; cachedUntil: number }>();
  constructor(readonly capacity = 256, readonly clock = Date.now) {}
  async get(key: string, create: () => Promise<AttachmentDownload>): Promise<AttachmentDownload> {
    const now = this.clock();
    for (const [k, entry] of this.#entries) if (entry.cachedUntil <= now) this.#entries.delete(k);
    const hit = this.#entries.get(key);
    if (hit) return hit.value;
    const value = await create();
    const cachedUntil = Math.min(this.clock() + 5 * 60_000, Date.parse(value.expiresAt) - 30_000);
    if (cachedUntil > this.clock()) {
      if (this.#entries.size >= this.capacity) { const first = this.#entries.keys().next().value; if (first !== undefined) this.#entries.delete(first); }
      this.#entries.set(key, { value, cachedUntil });
    }
    return value;
  }
  clear(): void { this.#entries.clear(); }
}
function missing(error: unknown): boolean {
  return error instanceof Error && ['NotFound', 'NoSuchKey', 'NoSuchVersion'].includes(error.name);
}

export function createAttachmentStorage(settings: AttachmentS3Settings): AttachmentStorage {
  const value = settings.values(), cache = new SignedDownloadCache();
  const client = new S3Client({ region: value.region, ...(value.endpoint ? { endpoint: value.endpoint } : {}), forcePathStyle: value.forcePathStyle,
    credentials: { accessKeyId: value.accessKeyId, secretAccessKey: value.secretAccessKey, ...(value.sessionToken ? { sessionToken: value.sessionToken } : {}) },
    // Non-replayable input stream: retries get a new durable attempt/key. Optional AWS CRC trailers
    // are not assumed across S3-compatible providers; HTTPS and the stream SHA-256 remain enforced.
    maxAttempts: 1, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
  });
  async function sign(row: AttachmentRecord, media?: AttachmentMedia): Promise<AttachmentDownload> {
    if (row.storageId !== settings.storageId) throw temporarilyUnavailableError();
    const key = JSON.stringify([row.objectKey, row.versionId, row.fileName, media?.contentType ?? 'download']);
    return cache.get(key, async () => {
      try {
        const signedAt = new Date();
        const url = await getSignedUrl(client, new GetObjectCommand({ Bucket: value.bucket, Key: row.objectKey,
          ...(row.versionId ? { VersionId: row.versionId } : {}),
          // Signed response overrides also work for existing application/octet-stream objects.
          ...(media ? { ResponseContentType: media.contentType, ResponseContentDisposition: 'inline', ResponseCacheControl: 'private, no-store' } : {}),
        }), { expiresIn: value.ttlSeconds, signingDate: signedAt });
        return { url, expiresAt: new Date(signedAt.getTime() + value.ttlSeconds * 1000).toISOString() };
      } catch { throw temporarilyUnavailableError(); }
    });
  }
  return {
    storageId: settings.storageId,
    async upload(row, source, signal) {
      if (row.storageId !== settings.storageId) throw temporarilyUnavailableError();
      const digest = createHash('sha256');
      let size = 0;
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          size += chunk.length;
          if (size > MAX_ATTACHMENT_BYTES || size > row.sizeBytes) { done(new HttpError(413, 'PAYLOAD_TOO_LARGE', 'The file exceeds its allowed size.')); return; }
          digest.update(chunk); done(null, chunk);
        },
        flush(done) { done(size === row.sizeBytes ? null : new HttpError(400, 'ATTACHMENT_SIZE_MISMATCH', 'The file size changed.')); },
      });
      const controller = new AbortController();
      const abort = () => { controller.abort(); limiter.destroy(new Error('Upload aborted.')); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      let transferError: unknown;
      const transfer = pipeline(source, limiter).catch((error: unknown) => { transferError = error; controller.abort(); throw error; });
      const put = client.send(new PutObjectCommand({ Bucket: value.bucket, Key: row.objectKey, Body: limiter, ContentLength: row.sizeBytes,
        ContentType: 'application/octet-stream', ContentDisposition: downloadDisposition(row.fileName), CacheControl: 'private, no-store',
      }), { abortSignal: controller.signal }).catch((error: unknown) => { limiter.destroy(new Error('Storage write failed.')); throw error; });
      try {
        const results = await Promise.allSettled([transfer, put]);
        if (transferError instanceof HttpError) throw transferError;
        const stored = results[1];
        if (results[0].status !== 'fulfilled' || stored.status !== 'fulfilled' || signal.aborted) throw temporarilyUnavailableError();
        return { checksum: digest.digest('hex'), versionId: stored.value.VersionId ?? null };
      } finally { signal.removeEventListener('abort', abort); }
    },
    signDownload: row => sign(row),
    async signPreview(row) {
      const media = attachmentMedia(row.fileName);
      if (!media) throw new HttpError(415, 'ATTACHMENT_PREVIEW_UNSUPPORTED', 'Preview is unavailable for this file type.');
      const signed = await sign(row, media);
      // The helper's allowlist determines both the native decoder and the signed response MIME type.
      return { ...signed, attachmentId: row.id, ...media };
    },
    invalidate(_objectKey) { cache.clear(); },
    async remove(objectKey, versionId) {
      // Resolve an unknown version after an ambiguous PUT result; never use an unscoped bucket sweep.
      const signal = AbortSignal.timeout(20_000);
      try {
        const found = await client.send(new HeadObjectCommand({ Bucket: value.bucket, Key: objectKey, ...(versionId ? { VersionId: versionId } : {}) }), { abortSignal: signal });
        const version = versionId ?? found.VersionId;
        await client.send(new DeleteObjectCommand({ Bucket: value.bucket, Key: objectKey, ...(version ? { VersionId: version } : {}) }), { abortSignal: signal });
      } catch (error) { if (!missing(error)) throw temporarilyUnavailableError(); }
    },
    close() { cache.clear(); client.destroy(); },
  };
}
