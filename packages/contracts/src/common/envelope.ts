import { z } from 'zod';

/** `meta` of every successful response; lists add `nextCursor` (null on the last page). */
export const responseMetaSchema = z.object({
  requestId: z.string(),
  nextCursor: z.string().nullable().optional(),
});

/** Wraps a payload schema in the standard `{ data, meta }` success envelope. */
export function envelopeSchema<TData extends z.ZodType>(data: TData) {
  return z.object({ data, meta: responseMetaSchema });
}

/** Error body for every non-2xx API response. `details` never carries secrets or hidden objects. */
export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
    retryable: z.boolean(),
  }),
  meta: z.object({
    requestId: z.string(),
  }),
});

export type ResponseMeta = z.infer<typeof responseMetaSchema>;
export type Envelope<TData> = { data: TData; meta: ResponseMeta };
export type ErrorResponseDto = z.infer<typeof errorResponseSchema>;
export type ErrorDto = ErrorResponseDto['error'];
