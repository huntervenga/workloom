import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { temporarilyUnavailableError, type AvatarRecord } from '@workloom/domain';
import type { AttachmentS3Settings } from '../attachments/config.js';
import { SignedDownloadCache } from '../attachments/storage.js';

export interface AvatarStorage {
  storageId: string;
  upload(row: AvatarRecord, body: Buffer): Promise<string | null>;
  url(row: AvatarRecord): Promise<string>;
  remove(objectKey: string, versionId: string | null): Promise<void>;
  close(): void;
}
export function createAvatarStorage(settings: AttachmentS3Settings): AvatarStorage {
  const value = settings.values(), cache = new SignedDownloadCache();
  const client = new S3Client({ region: value.region, ...(value.endpoint ? { endpoint: value.endpoint } : {}), forcePathStyle: value.forcePathStyle,
    credentials: { accessKeyId: value.accessKeyId, secretAccessKey: value.secretAccessKey, ...(value.sessionToken ? { sessionToken: value.sessionToken } : {}) },
    maxAttempts: 1, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
  const check = (row: AvatarRecord) => { if (row.storageId !== settings.storageId || !row.objectKey.startsWith('avatars/')) throw temporarilyUnavailableError(); };
  return {
    storageId: settings.storageId,
    async upload(row, body) {
      check(row);
      try {
        const result = await client.send(new PutObjectCommand({ Bucket: value.bucket, Key: row.objectKey, Body: body, ContentLength: body.length,
          ContentType: 'image/webp', ContentDisposition: 'inline', CacheControl: 'private, no-store' }), { abortSignal: AbortSignal.timeout(45_000) });
        return result.VersionId ?? null;
      } catch { throw temporarilyUnavailableError(); }
    },
    async url(row) {
      check(row);
      const result = await cache.get(JSON.stringify([row.objectKey, row.versionId]), async () => {
        try {
          const signedAt = new Date();
          const url = await getSignedUrl(client, new GetObjectCommand({ Bucket: value.bucket, Key: row.objectKey,
            ...(row.versionId ? { VersionId: row.versionId } : {}), ResponseContentType: 'image/webp', ResponseContentDisposition: 'inline', ResponseCacheControl: 'private, no-store' }),
          { expiresIn: value.ttlSeconds, signingDate: signedAt });
          return { url, expiresAt: new Date(signedAt.getTime() + value.ttlSeconds * 1000).toISOString() };
        } catch { throw temporarilyUnavailableError(); }
      });
      return result.url;
    },
    async remove(objectKey, versionId) {
      if (!objectKey.startsWith('avatars/')) throw temporarilyUnavailableError();
      const signal = AbortSignal.timeout(20_000);
      try {
        const object = await client.send(new HeadObjectCommand({ Bucket: value.bucket, Key: objectKey, ...(versionId ? { VersionId: versionId } : {}) }), { abortSignal: signal });
        const version = versionId ?? object.VersionId;
        await client.send(new DeleteObjectCommand({ Bucket: value.bucket, Key: objectKey, ...(version ? { VersionId: version } : {}) }), { abortSignal: signal });
        cache.clear();
      } catch (error) { if (!(error instanceof Error && ['NotFound', 'NoSuchKey', 'NoSuchVersion'].includes(error.name))) throw temporarilyUnavailableError(); }
    },
    close() { cache.clear(); client.destroy(); },
  };
}
