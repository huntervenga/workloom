import {
  issueLocalCredentialInputSchema, revokeLocalCredentialInputSchema,
  localCredentialListResponseSchema, localCredentialResponseSchema,
  type IssueLocalCredentialInput, type RevokeLocalCredentialInput,
} from '@workloom/contracts';
import { apiGet, prepareMutation } from '../../lib/api';
const path = (w: string) => `/api/v1/workspaces/${encodeURIComponent(w)}/mcp-credentials`;
export async function fetchLocalCredentials(a: string, w: string, signal?: AbortSignal) {
  const parser = localCredentialListResponseSchema.refine(result => result.data.credentials.every(row => row.workspaceId === w && row.ownerUserId === a));
  return (await apiGet(path(w), parser, signal)).data;
}
export const issueCredentialRequest = (a: string, w: string, input: IssueLocalCredentialInput) => prepareMutation({
  method: 'POST', path: path(w), input, inputSchema: issueLocalCredentialInputSchema,
  responseSchema: localCredentialResponseSchema.refine(result => result.data.id === input.id && result.data.workspaceId === w && result.data.ownerUserId === a && result.data.name === input.name.trim() && JSON.stringify([...result.data.scopes].sort()) === JSON.stringify([...input.scopes].sort())),
});
export const revokeCredentialRequest = (a: string, w: string, id: string, input: RevokeLocalCredentialInput) => prepareMutation({
  method: 'POST', path: `${path(w)}/${encodeURIComponent(id)}/revoke`, input, inputSchema: revokeLocalCredentialInputSchema,
  responseSchema: localCredentialResponseSchema.refine(result => result.data.id === id && result.data.workspaceId === w && result.data.ownerUserId === a && result.data.revokedAt !== null),
});
