import type { LeaveWarningsDto } from '@workloom/contracts';
import { DomainError } from '@workloom/domain';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';

/** Parses untrusted input; failures become VALIDATION_FAILED with field paths only (no input values). */
export function parseInput<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.map(String).join('.') || '(root)'))];
    throw new DomainError('VALIDATION_FAILED', 'The request is invalid.', { details: { fields } });
  }
  return result.data;
}

/**
 * Builds `{ data, meta }`, validates it against the contract envelope schema
 * (unknown fields are stripped) and sends it. A mismatch is a server bug → 500.
 * Lists send `meta.nextCursor`: the given opaque cursor for paged lists, otherwise null.
 */
export function sendData<T extends z.ZodType>(
  request: FastifyRequest,
  reply: FastifyReply,
  schema: T,
  data: unknown,
  options: { statusCode?: number; list?: boolean; nextCursor?: string | null; leaveWarnings?: LeaveWarningsDto } = {},
): FastifyReply {
  const meta =
    options.nextCursor !== undefined
      ? { requestId: request.id, nextCursor: options.nextCursor }
      : options.list === true
        ? { requestId: request.id, nextCursor: null }
        : { requestId: request.id };
  const parsed = schema.safeParse({ data, meta: { ...meta, ...(options.leaveWarnings ? { leaveWarnings: options.leaveWarnings } : {}) } });
  if (!parsed.success) {
    throw new Error('Response did not match its contract schema.');
  }
  return reply.code(options.statusCode ?? 200).send(parsed.data);
}
