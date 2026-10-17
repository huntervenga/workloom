import { z } from 'zod';
import { envelopeSchema, responseMetaSchema } from './common/envelope.js';
import { idSchema } from './common/ids.js';
import { workspaceRoleSchema } from './workspaces.js';

const canonicalDecimal = /^(0|[1-9][0-9]*)$/;
/** Exact nonnegative PostgreSQL bigint, including the untouched workspace's zero head. */
const changeHeadDecimalSchema = z.string().max(19).regex(canonicalDecimal).refine(
  value => value.length <= 19 && canonicalDecimal.test(value) && BigInt(value) <= 9223372036854775807n,
  'Expected a nonnegative PostgreSQL bigint decimal string.',
);

/** No client-selected actor, membership, cursor or sequence is accepted. */
export const workspaceChangeHeadQuerySchema = z.strictObject({});
export const workspaceChangeHeadSchema = z.strictObject({
  workspaceId: idSchema,
  actorUserId: idSchema,
  membershipId: idSchema,
  membershipRevision: z.number().int().min(1).max(2147483647),
  role: workspaceRoleSchema,
  changeSeq: changeHeadDecimalSchema,
  permissionEpoch: changeHeadDecimalSchema,
});
export const workspaceChangeHeadResponseSchema = envelopeSchema(workspaceChangeHeadSchema).extend({
  meta: responseMetaSchema.strict(),
}).strict();
export type WorkspaceChangeHeadDto = z.infer<typeof workspaceChangeHeadSchema>;
