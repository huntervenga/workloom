import {z} from 'zod';
import {idSchema} from './common/ids.js';
import {envelopeSchema} from './common/envelope.js';
import {utcTimestampSchema} from './tasks.js';
import {membershipSchema} from './workspaces.js';
export const teamInviteRoleSchema=z.enum(['admin','member','viewer']);
export const teamMembershipSchema=membershipSchema.extend({state:z.enum(['active','revoked']),revision:z.number().int().positive(),revokedAt:utcTimestampSchema.nullable()});
export const teamInvitationSchema=z.object({id:idSchema,workspaceId:idSchema,role:teamInviteRoleSchema,hashVersion:z.literal(1),createdByUserId:idSchema,createdByMembershipId:idSchema,createdAt:utcTimestampSchema,expiresAt:utcTimestampSchema,revision:z.number().int().positive(),revokedAt:utcTimestampSchema.nullable(),acceptedAt:utcTimestampSchema.nullable(),acceptedByUserId:idSchema.nullable(),acceptedMembershipId:idSchema.nullable()});
export const issueTeamInvitationInputSchema=z.object({id:idSchema,hashVersion:z.literal(1),secretHash:z.string().regex(/^[a-f0-9]{64}$/),role:teamInviteRoleSchema,expiresInSeconds:z.number().int().min(60).max(604800)}).strict();
export const revokeTeamInvitationInputSchema=z.object({expectedRevision:z.number().int().positive()}).strict();
export const updateTeamMembershipInputSchema=z.object({expectedRevision:z.number().int().positive(),role:teamInviteRoleSchema,state:z.enum(['active','revoked'])}).strict();
export const acceptTeamInvitationInputSchema=z.object({invitationId:idSchema,secret:z.string().regex(/^[A-Za-z0-9_-]{43}$/)}).strict();
export const acceptTeamInvitationResultSchema=z.object({workspaceId:idSchema,membershipId:idSchema});
export const teamViewSchema=z.object({members:z.array(teamMembershipSchema).max(1000),invitations:z.array(teamInvitationSchema).max(1000),allowedInviteRoles:z.array(teamInviteRoleSchema).max(3)});
export const teamViewResponseSchema=envelopeSchema(teamViewSchema);
export const teamInvitationResponseSchema=envelopeSchema(teamInvitationSchema);
export const teamMembershipResponseSchema=envelopeSchema(teamMembershipSchema);
export const acceptTeamInvitationResponseSchema=envelopeSchema(acceptTeamInvitationResultSchema);
export type TeamInviteRole=z.infer<typeof teamInviteRoleSchema>;
export type TeamMembershipDto=z.infer<typeof teamMembershipSchema>;
export type TeamInvitationDto=z.infer<typeof teamInvitationSchema>;
export type TeamViewDto=z.infer<typeof teamViewSchema>;
export type IssueTeamInvitationInput=z.infer<typeof issueTeamInvitationInputSchema>;
export type RevokeTeamInvitationInput=z.infer<typeof revokeTeamInvitationInputSchema>;
export type UpdateTeamMembershipInput=z.infer<typeof updateTeamMembershipInputSchema>;
export type AcceptTeamInvitationInput=z.infer<typeof acceptTeamInvitationInputSchema>;
export type AcceptTeamInvitationResult=z.infer<typeof acceptTeamInvitationResultSchema>;
/** Public deterministic UTF-8 preimage, shared by WebCrypto and Node SHA-256. */
export function teamInvitationSecretPreimage(id:string,secret:Uint8Array):Uint8Array {
 if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)||secret.length!==32)throw new TypeError('Invalid invitation material.');
 return Uint8Array.from(`workloom-invite:v1:${id.toLowerCase()}:${Array.from(secret,x=>x.toString(16).padStart(2,'0')).join('')}`,x=>x.charCodeAt(0));
}
