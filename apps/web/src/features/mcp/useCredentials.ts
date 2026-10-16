import { useTranslation } from '../../i18n';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { IssueLocalCredentialInput, LocalCredentialDto, LocalMcpScope } from '@workloom/contracts';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { apiGet, isAccessDenied } from '../../lib/api';
import { workspaceResponseSchema } from '@workloom/contracts';
import { queryKeys } from '../../lib/queryKeys';
import { useIdempotentMutation, type IdempotentVariables } from '../../lib/useIdempotentMutation';
import { useProtectedDraft } from '../../lib/protectedDrafts';
import { useUnsavedChangesWarning } from '../../lib/useUnsavedChangesWarning';
import { fetchLocalCredentials, issueCredentialRequest, revokeCredentialRequest } from './api';
import { generateCredentialSecret, type CredentialSecret } from './secret';
interface IssueVariables extends IdempotentVariables { input: IssueLocalCredentialInput }
interface RevokeVariables extends IdempotentVariables { credentialId: string; input: { expectedRevision: number } }
export function useCredentials(actorId: string, workspaceId: string) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const key = [...queryKeys.workspace(actorId, workspaceId), 'local-mcp-credentials'];
  const list = useQuery({ queryKey: key, queryFn: ({ signal }) => fetchLocalCredentials(actorId, workspaceId, signal), retry: false });
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<LocalMcpScope[]>([]);
  const [ttl, setTtl] = useState(3600);
  const [material, setMaterial] = useState<CredentialSecret | null>(null);
  const materialRef = useRef<CredentialSecret | null>(null);
  const preparedRef = useRef<IssueVariables | null>(null);
  const [issued, setIssued] = useState<LocalCredentialDto | null>(null);
  const [generating, setGenerating] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const mounted = useRef(true), generation = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; materialRef.current = null; preparedRef.current = null; }; }, []);
  const forget = useCallback(() => { materialRef.current = null; preparedRef.current = null; setMaterial(null); setIssued(null); }, []);
  const issue = useIdempotentMutation({ prepare: (v: IssueVariables) => issueCredentialRequest(actorId, workspaceId, v.input), onSuccess: (data, variables) => {
    void client.invalidateQueries({ queryKey: key });
    if (mounted.current && materialRef.current?.id === variables.input.id) setIssued(data);
  } });
  const revoke = useIdempotentMutation({ prepare: (v: RevokeVariables) => revokeCredentialRequest(actorId, workspaceId, v.credentialId, v.input), onSuccess: (data) => {
    void client.invalidateQueries({ queryKey: key });
    if (mounted.current && materialRef.current?.id === data.id) forget();
  } });
  const issueHeld = issue.pendingCommand?.variables ?? issue.uncertain?.variables;
  const revokeHeld = revoke.pendingCommand?.variables ?? revoke.uncertain?.variables;
  const readDenied = [list.error, issue.error, revoke.error].some(isAccessDenied);
  useLayoutEffect(() => { if (readDenied) setDenied(true); }, [readDenied]);
  const blocked = denied || readDenied;
  const held = !!issueHeld || !!revokeHeld;
  const allowed = list.isSuccess && !blocked ? list.data.allowedScopes : [];
  const canIssue = !blocked && !held && !generating && !issued && name.trim().length > 0 && name.trim().length <= 100 && scopes.length > 0 && scopes.every(scope => allowed.includes(scope)) && (list.data?.credentials.length ?? 100) < 100;
  async function submit() {
    if (!canIssue || generation.current) return;
    generation.current = true; setGenerating(true); setLocalError(null);
    const inputName = name, inputScopes = [...scopes], expiresInSeconds = ttl;
    try {
      const next = materialRef.current ?? await generateCredentialSecret();
      if (!mounted.current) return;
      materialRef.current = next; setMaterial(next);
      const prepared = preparedRef.current ?? { idempotencyKey: crypto.randomUUID(), input: { id: next.id, name: inputName, secretHash: next.secretHash, hashVersion: 1 as const, scopes: inputScopes, expiresInSeconds } };
      preparedRef.current = prepared; issue.mutate(prepared);
    } catch { if (mounted.current) setLocalError(t('mcp.secureCredentialGenerationIsUnavailableInThisBrowserUse')); }
    finally { generation.current = false; if (mounted.current) setGenerating(false); }
  }
  async function recover() {
    if (recovering) return;
    setRecovering(true);
    try {
      const [workspace, result] = await Promise.all([apiGet(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}`, workspaceResponseSchema), list.refetch()]);
      if (mounted.current && workspace.data.id === workspaceId && result.isSuccess) { issue.reset(); revoke.reset(); setDenied(false); }
    } catch { /* Keep the authoritative denial latched until both current reads succeed. */ }
    finally { if (mounted.current) setRecovering(false); }
  }
  const dirty = !!material || name.length > 0 || scopes.length > 0 || ttl !== 3600;
  useProtectedDraft(dirty);
  useUnsavedChangesWarning(held || dirty);
  return { list, name, setName, scopes, setScopes, ttl, setTtl, material, issued, generating, localError, denied: blocked, recovering, recover, issue, revoke, issueHeld, revokeHeld, held, allowed, canIssue, submit, forget };
}
export type CredentialController = ReturnType<typeof useCredentials>;
