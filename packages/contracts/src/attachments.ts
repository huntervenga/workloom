import { z } from 'zod';
import { envelopeSchema } from './common/envelope.js';
import { idSchema } from './common/ids.js';
import { utcTimestampSchema } from './tasks.js';

export const MAX_TASK_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 50_000_000;
export const ATTACHMENT_UPLOAD_TTL_MS = 15 * 60_000;
export const attachmentStateSchema = z.enum(['pending', 'uploading', 'ready', 'failed', 'expired', 'deleted']);
export const attachmentFeatureSchema = z.strictObject({
  enabled: z.boolean(),
  reason: z.enum(['storage_not_configured', 'storage_configuration_invalid']).nullable(),
  limits: z.strictObject({ maxFilesPerTask: z.literal(5), maxFileSizeBytes: z.literal(50_000_000) }),
  uploadMode: z.literal('api-stream'), downloadMode: z.literal('signed-url'),
  downloadUrlTtlSeconds: z.number().int().min(60).max(7200),
});
export const serverFeaturesResponseSchema = envelopeSchema(z.strictObject({
  features: z.strictObject({ taskAttachments: attachmentFeatureSchema }),
}));
export const attachmentNameSchema = z.string().trim().min(1).max(240).refine(
  name => !/[\p{Cc}\p{Cs}/\\]/u.test(name) && name !== '.' && name !== '..',
  'Use a file name without paths or control characters.',
);
export const reserveAttachmentInputSchema = z.strictObject({
  fileName: attachmentNameSchema,
  sizeBytes: z.number().int().min(0).max(MAX_ATTACHMENT_BYTES),
  expectedActorId: idSchema,
});
export const deleteAttachmentInputSchema = z.strictObject({
  expectedRevision: z.number().int().positive(), expectedActorId: idSchema,
});
export const taskAttachmentSchema = z.strictObject({
  id: idSchema, workspaceId: idSchema, taskId: idSchema, uploadedByUserId: idSchema,
  fileName: attachmentNameSchema, sizeBytes: z.number().int().min(0).max(MAX_ATTACHMENT_BYTES),
  state: attachmentStateSchema, revision: z.number().int().positive(),
  createdAt: utcTimestampSchema, uploadExpiresAt: utcTimestampSchema,
});
export const taskAttachmentListSchema = z.strictObject({
  items: z.array(taskAttachmentSchema).max(MAX_TASK_ATTACHMENTS),
  remainingSlots: z.number().int().min(0).max(MAX_TASK_ATTACHMENTS),
  canUpload: z.boolean(), canDelete: z.boolean(),
});
export const taskAttachmentResponseSchema = envelopeSchema(taskAttachmentSchema);
export const taskAttachmentsResponseSchema = envelopeSchema(taskAttachmentListSchema);
export const attachmentDownloadSchema = z.strictObject({ url: z.url(), expiresAt: utcTimestampSchema });
export const attachmentDownloadResponseSchema = envelopeSchema(attachmentDownloadSchema);
// Only passive raster images and native video decoders are eligible. Never embed HTML/SVG/PDF.
const imageContentTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/x-icon'] as const;
const videoContentTypes = ['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime'] as const;
export const attachmentPreviewSchema = z.discriminatedUnion('kind', [
  attachmentDownloadSchema.extend({ attachmentId: idSchema, kind: z.literal('image'), contentType: z.enum(imageContentTypes) }),
  attachmentDownloadSchema.extend({ attachmentId: idSchema, kind: z.literal('video'), contentType: z.enum(videoContentTypes) }),
]);
export const attachmentPreviewResponseSchema = envelopeSchema(attachmentPreviewSchema);
export type AttachmentPreview = z.infer<typeof attachmentPreviewSchema>;
export type AttachmentMedia = { kind: 'image'; contentType: typeof imageContentTypes[number] }
  | { kind: 'video'; contentType: typeof videoContentTypes[number] };
const images: Record<string, typeof imageContentTypes[number]> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', png: 'image/png', apng: 'image/png',
  gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
};
const videos: Record<string, typeof videoContentTypes[number]> = {
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime',
};
/** Extension is a decoder hint, not proof of file content. A decoding failure falls back to download. */
export function attachmentMedia(fileName: string): AttachmentMedia | null {
  const extension = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase();
  if (!fileName.includes('.')) return null;
  const imageType = Object.hasOwn(images, extension) ? images[extension] : undefined;
  const videoType = Object.hasOwn(videos, extension) ? videos[extension] : undefined;
  return imageType ? { kind: 'image', contentType: imageType } : videoType ? { kind: 'video', contentType: videoType } : null;
}
export type AttachmentFeature = z.infer<typeof attachmentFeatureSchema>;
export type TaskAttachmentDto = z.infer<typeof taskAttachmentSchema>;
export type TaskAttachmentList = z.infer<typeof taskAttachmentListSchema>;
export type ReserveAttachmentInput = z.infer<typeof reserveAttachmentInputSchema>;
export type DeleteAttachmentInput = z.infer<typeof deleteAttachmentInputSchema>;
export type AttachmentDownload = z.infer<typeof attachmentDownloadSchema>;
