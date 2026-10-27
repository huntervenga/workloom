import { createHash } from 'node:crypto';
import { inspect } from 'node:util';
import { Readable } from 'node:stream';
import { S3Client, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import type { AttachmentRecord } from '@workloom/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachmentFeature, loadAttachmentConfig } from './config.js';
import { createAttachmentStorage, downloadDisposition, SignedDownloadCache } from './storage.js';

const env = { ATTACHMENTS_S3_BUCKET: 'private-files', ATTACHMENTS_S3_REGION: 'auto', ATTACHMENTS_S3_ENDPOINT: 'https://objects.example.test',
  ATTACHMENTS_S3_FORCE_PATH_STYLE: 'true', AWS_ACCESS_KEY_ID: 'test-access', AWS_SECRET_ACCESS_KEY: 'test-secret' };
function configured(extra: Record<string, string> = {}) {
  const config = loadAttachmentConfig({ ...env, ...extra }, true);
  if (!config.enabled) throw new Error('Expected configured storage.');
  return config.settings;
}
const row = (storageId: string, sizeBytes = 3): AttachmentRecord => ({ id: '10000000-0000-4000-8000-000000000001',
  workspaceId: '10000000-0000-4000-8000-000000000002', taskId: '10000000-0000-4000-8000-000000000003', uploadedByUserId: '10000000-0000-4000-8000-000000000004',
  storageId, objectKey: 'attachments/test/random', slot: 1, fileName: 'report.html', sizeBytes, state: 'uploading', revision: 2,
  versionId: null, checksum: null, createdAt: new Date().toISOString(), uploadExpiresAt: new Date(Date.now() + 60_000).toISOString() });
afterEach(() => { vi.restoreAllMocks(); });

describe('optional attachment storage', () => {
  it('disables absent and partial configuration without throwing or exposing secrets', () => {
    for (const input of [{}, { ATTACHMENTS_S3_BUCKET: 'private-files' }, { ...env, AWS_SECRET_ACCESS_KEY: '' }, { ...env, ATTACHMENTS_SIGNED_URL_TTL_SECONDS: 'invalid' }]) {
      const config = loadAttachmentConfig(input, true);
      expect(config.enabled).toBe(false);
      expect(attachmentFeature(config).enabled).toBe(false);
    }
    const config = loadAttachmentConfig(env, true);
    expect(attachmentFeature(config)).toMatchObject({ enabled: true, downloadUrlTtlSeconds: 3600, limits: { maxFilesPerTask: 5, maxFileSizeBytes: 50_000_000 } });
    expect(JSON.stringify(config)).not.toContain('test-secret');
    expect(inspect(config)).not.toContain('test-access');
  });

  it('accepts custom HTTPS providers, bounds TTL, and allows HTTP only for local loopback', () => {
    expect(configured({ ATTACHMENTS_SIGNED_URL_TTL_SECONDS: '7200' }).values().ttlSeconds).toBe(7200);
    for (const endpoint of ['http://objects.example.test', 'https://user:secret@objects.example.test', 'https://objects.example.test/bucket']) {
      expect(loadAttachmentConfig({ ...env, ATTACHMENTS_S3_ENDPOINT: endpoint }, true).enabled).toBe(false);
    }
    expect(loadAttachmentConfig({ ...env, ATTACHMENTS_S3_ENDPOINT: 'http://127.0.0.1:9000' }, false).enabled).toBe(true);
    expect(loadAttachmentConfig({ ...env, ATTACHMENTS_S3_ENDPOINT: 'http://127.0.0.1:9000' }, true).enabled).toBe(false);
    for (const ttl of ['59', '7201']) expect(loadAttachmentConfig({ ...env, ATTACHMENTS_SIGNED_URL_TTL_SECONDS: ttl }, true).enabled).toBe(false);
  });

  it('streams exact bytes to a single PUT and preserves version and SHA-256', async () => {
    const send = vi.spyOn(S3Client.prototype, 'send').mockImplementation(async command => {
      expect(command).toBeInstanceOf(PutObjectCommand);
      const input = (command as PutObjectCommand).input;
      expect(input).toMatchObject({ ContentLength: 3, ContentType: 'application/octet-stream', CacheControl: 'private, no-store' });
      expect(input.ContentDisposition).toMatch(/^attachment;/);
      const bytes: Buffer[] = [];
      for await (const chunk of input.Body as Readable) bytes.push(Buffer.from(chunk));
      expect(Buffer.concat(bytes).toString()).toBe('abc');
      return { VersionId: 'version-1' };
    });
    const storage = createAttachmentStorage(configured());
    try {
      expect(await storage.upload(row(storage.storageId), Readable.from([Buffer.from('a'), Buffer.from('bc')]), new AbortController().signal))
        .toEqual({ versionId: 'version-1', checksum: createHash('sha256').update('abc').digest('hex') });
      expect(send).toHaveBeenCalledTimes(1);
    } finally { storage.close(); }
  });

  it.each([[4, 3, 413], [2, 3, 400]])('rejects actual size %i for reservation %i', async (actual, declared, statusCode) => {
    vi.spyOn(S3Client.prototype, 'send').mockImplementation(async command => {
      for await (const chunk of (command as PutObjectCommand).input.Body as Readable) void chunk;
      return {};
    });
    const storage = createAttachmentStorage(configured());
    try { await expect(storage.upload(row(storage.storageId, declared), Readable.from([Buffer.alloc(actual)]), new AbortController().signal)).rejects.toMatchObject({ statusCode }); }
    finally { storage.close(); }
  });

  it.each([50_000_000, 50_000_001])('enforces the real 50 MB boundary for a generated %i-byte stream', async size => {
    vi.spyOn(S3Client.prototype, 'send').mockImplementation(async command => {
      for await (const chunk of (command as PutObjectCommand).input.Body as Readable) void chunk;
      return {};
    });
    const storage = createAttachmentStorage(configured());
    function* bytes() {
      const chunk = Buffer.alloc(16_384);
      for (let remaining = size; remaining > 0; remaining -= chunk.length) yield chunk.subarray(0, Math.min(remaining, chunk.length));
    }
    try {
      const uploading = storage.upload(row(storage.storageId, 50_000_000), Readable.from(bytes()), new AbortController().signal);
      if (size === 50_000_000) expect((await uploading).checksum).toMatch(/^[a-f0-9]{64}$/);
      else await expect(uploading).rejects.toMatchObject({ statusCode: 413 });
    } finally { storage.close(); }
  });

  it('produces cached provider-specific signed GETs locally, without calling S3', async () => {
    const send = vi.spyOn(S3Client.prototype, 'send');
    const storage = createAttachmentStorage(configured()), record = { ...row(storage.storageId), state: 'ready' as const, versionId: 'immutable-v1' };
    try {
      const first = await storage.signDownload(record), second = await storage.signDownload(record);
      expect(first).toBe(second);
      const url = new URL(first.url);
      expect(url.origin).toBe(env.ATTACHMENTS_S3_ENDPOINT);
      expect(url.pathname).toBe('/private-files/attachments/test/random');
      expect(url.searchParams.get('X-Amz-Expires')).toBe('3600');
      expect(url.searchParams.get('versionId')).toBe('immutable-v1');
      expect(send).not.toHaveBeenCalled();
      await expect(storage.signDownload({ ...record, storageId: '0'.repeat(64) })).rejects.toMatchObject({ code: 'TEMPORARILY_UNAVAILABLE' });
    } finally { storage.close(); }
  });

  it.each([['photo.PNG', 'image', 'image/png'], ['clip.mp4', 'video', 'video/mp4']])(
    'signs passive preview overrides for %s, separately from downloads without changing the object', async (fileName, kind, contentType) => {
      const send = vi.spyOn(S3Client.prototype, 'send');
      const storage = createAttachmentStorage(configured());
      const record = { ...row(storage.storageId), state: 'ready' as const, versionId: 'existing-version', fileName };
      try {
        const download = await storage.signDownload(record), preview = await storage.signPreview(record);
        expect(preview).toMatchObject({ attachmentId: record.id, kind, contentType });
        const url = new URL(preview.url), params = url.searchParams;
        expect(params.get('response-content-type')).toBe(contentType);
        expect(params.get('response-content-disposition')).toBe('inline');
        expect(params.get('response-cache-control')).toBe('private, no-store');
        expect(params.get('versionId')).toBe('existing-version');
        expect(params.get('X-Amz-Expires')).toBe('3600');
        expect(params.get('X-Amz-Signature')).toMatch(/^[a-f0-9]{64}$/);
        expect(new URL(download.url).searchParams.has('response-content-disposition')).toBe(false);
        expect(download.url).not.toBe(preview.url);
        expect(await storage.signDownload(record)).toBe(download);
        expect(await storage.signPreview(record)).toEqual(preview);
        expect(send).not.toHaveBeenCalled();
        await expect(storage.signPreview({ ...record, storageId: '0'.repeat(64) })).rejects.toMatchObject({ code: 'TEMPORARILY_UNAVAILABLE' });
      } finally { storage.close(); }
    });

  it.each(['script.html', 'image.svg', 'image.png.html', 'document.pdf', 'constructor', 'no-extension', 'photo.heic'])(
    'keeps %s download-only', async fileName => {
      const storage = createAttachmentStorage(configured());
      try {
        await expect(storage.signPreview({ ...row(storage.storageId), fileName })).rejects.toMatchObject({ statusCode: 415 });
      } finally { storage.close(); }
    });

  it('resolves and deletes the exact object version after an ambiguous write', async () => {
    const send = vi.spyOn(S3Client.prototype, 'send').mockImplementation(async command => {
      if (command instanceof HeadObjectCommand) return { VersionId: 'late-version' };
      expect(command).toBeInstanceOf(DeleteObjectCommand);
      expect((command as DeleteObjectCommand).input).toMatchObject({ Key: 'attachments/test/random', VersionId: 'late-version' });
      return {};
    });
    const storage = createAttachmentStorage(configured());
    try { await storage.remove('attachments/test/random', null); expect(send).toHaveBeenCalledTimes(2); }
    finally { storage.close(); }
  });

  it('bounds the cache and refreshes before URL expiry, including after invalidation', async () => {
    let now = 0, calls = 0;
    const cache = new SignedDownloadCache(2, () => now);
    const make = async () => ({ url: `https://example.test/${++calls}`, expiresAt: new Date(now + 60_000).toISOString() });
    const first = await cache.get('a', make);
    expect(await cache.get('a', make)).toBe(first);
    now = 30_001;
    expect(await cache.get('a', make)).not.toBe(first);
    await cache.get('b', make); await cache.get('c', make); await cache.get('a', make);
    expect(calls).toBe(5);
    cache.clear(); await cache.get('a', make); expect(calls).toBe(6);
  });

  it('encodes arbitrary names without adding executable or injected response headers', () => {
    const value = downloadDisposition('Пример "x".html\r\nX-Test: yes');
    expect(value).toMatch(/^attachment; filename="download"; filename\*=UTF-8''/);
    expect(value).not.toMatch(/[\r\n]/);
  });
});
