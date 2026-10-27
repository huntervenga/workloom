import { createHash } from 'node:crypto';
import type { AttachmentFeature } from '@workloom/contracts';

type Env = Readonly<Record<string, string | undefined>>;
interface Settings {
  bucket: string; region: string; endpoint?: string; forcePathStyle: boolean;
  accessKeyId: string; secretAccessKey: string; sessionToken?: string; ttlSeconds: number;
}
/** Secrets stay private even when the encompassing application config is inspected or logged. */
export class AttachmentS3Settings {
  readonly #value: Settings;
  readonly storageId: string;
  constructor(value: Settings) {
    this.#value = value;
    this.storageId = createHash('sha256').update(JSON.stringify([value.endpoint ?? 'aws', value.region, value.bucket, value.forcePathStyle])).digest('hex');
  }
  values(): Readonly<Settings> { return this.#value; }
  toJSON() { return '[redacted attachment storage settings]'; }
  [Symbol.for('nodejs.util.inspect.custom')]() { return this.toJSON(); }
}
export type AttachmentConfig = { enabled: true; settings: AttachmentS3Settings }
  | { enabled: false; reason: 'storage_not_configured' | 'storage_configuration_invalid' };

/** Optional configuration never throws or resolves credentials over the network during startup. */
export function loadAttachmentConfig(env: Env, hosted: boolean): AttachmentConfig {
  const read = (name: string) => env[name]?.trim() || undefined;
  const bucket = read('ATTACHMENTS_S3_BUCKET'), region = read('ATTACHMENTS_S3_REGION');
  const accessKeyId = read('AWS_ACCESS_KEY_ID'), secretAccessKey = read('AWS_SECRET_ACCESS_KEY');
  let endpoint = read('ATTACHMENTS_S3_ENDPOINT');
  if (!bucket && !region && !endpoint) return { enabled: false, reason: 'storage_not_configured' };
  if (!accessKeyId && !secretAccessKey) return { enabled: false, reason: 'storage_not_configured' };
  const invalid: AttachmentConfig = { enabled: false, reason: 'storage_configuration_invalid' };
  if (!bucket || !region || !accessKeyId || !secretAccessKey) return invalid;
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || !/^[a-zA-Z0-9_-]{1,80}$/.test(region)) return invalid;
  if (endpoint) {
    try {
      const url = new URL(endpoint);
      const local = !hosted && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
      if ((!local && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash || url.pathname !== '/') return invalid;
      endpoint = url.origin;
    } catch { return invalid; }
  }
  const pathStyle = read('ATTACHMENTS_S3_FORCE_PATH_STYLE') ?? 'false';
  const ttl = read('ATTACHMENTS_SIGNED_URL_TTL_SECONDS') ?? '3600';
  if (!['true', 'false'].includes(pathStyle) || !/^\d+$/.test(ttl) || Number(ttl) < 60 || Number(ttl) > 7200) return invalid;
  const sessionToken = read('AWS_SESSION_TOKEN');
  return { enabled: true, settings: new AttachmentS3Settings({ bucket, region, accessKeyId, secretAccessKey,
    forcePathStyle: pathStyle === 'true', ttlSeconds: Number(ttl), ...(endpoint ? { endpoint } : {}), ...(sessionToken ? { sessionToken } : {}) }) };
}
export function attachmentFeature(config?: AttachmentConfig): AttachmentFeature {
  return { enabled: config?.enabled === true, reason: config?.enabled ? null : config?.reason ?? 'storage_not_configured',
    limits: { maxFilesPerTask: 5, maxFileSizeBytes: 50_000_000 }, uploadMode: 'api-stream', downloadMode: 'signed-url',
    downloadUrlTtlSeconds: config?.enabled ? config.settings.values().ttlSeconds : 3600 };
}
