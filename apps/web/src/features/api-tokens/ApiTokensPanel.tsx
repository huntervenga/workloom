import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { ApiTokenDto, ApiTokenScope, CreatedApiTokenDto } from '@workloom/contracts';
import { Badge, Button, TextInput } from '@workloom/ui';
import { Check, Copy } from 'lucide-react';
import { formatDate, t, useTranslation } from '../../i18n';
import { describeError } from '../../lib/errors';
import { queryKeys } from '../../lib/queryKeys';
import { QueryErrorState } from '../../shared/QueryErrorState';
import { createApiToken, fetchApiTokens, revokeApiToken } from './api';

const EXPIRY_DAYS = [30, 90, 180, 365] as const;
const dateText = (value: string) => formatDate(new Date(value), { dateStyle: 'medium', timeStyle: 'short' });

function dayLabel(days: number): string {
  return days === 30 ? t('apiTokens.days30') : days === 90 ? t('apiTokens.days90') : days === 180 ? t('apiTokens.days180') : t('apiTokens.days365');
}

function Snippet({ label, text }: { label: string; text: string }) {
  return <div className="space-y-1"><p className="text-xs font-medium text-muted">{label}</p><pre className="overflow-x-auto rounded-lg bg-slate-900 p-3 text-xs leading-relaxed text-slate-100"><code>{text}</code></pre></div>;
}

type PanelProps = { actorId: string; workspaceId: string; workspaceName: string };

export function ApiTokensPanel(props: PanelProps) {
  return <ScopedApiTokensPanel key={`${props.actorId}:${props.workspaceId}`} {...props} />;
}

function ScopedApiTokensPanel({ actorId, workspaceId, workspaceName }: PanelProps) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const key = [...queryKeys.workspace(actorId, workspaceId), 'api-tokens'];
  const list = useQuery({ queryKey: key, queryFn: ({ signal }) => fetchApiTokens(signal), retry: false });
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiTokenScope[]>(['read', 'tasks:write']);
  const [reach, setReach] = useState<'all' | 'this'>('all');
  const [days, setDays] = useState<number>(90);
  const [created, setCreated] = useState<CreatedApiTokenDto | null>(null);
  const [copy, setCopy] = useState<'idle' | 'ok' | 'failed'>('idle');
  const refresh = () => client.invalidateQueries({ queryKey: key });
  const create = useMutation({
    mutationFn: async () => {
      const token = await createApiToken({ name, scopes, expiresInDays: days, ...(reach === 'this' ? { workspaceIds: [workspaceId] } : {}) });
      // The bearer is a one-time local display, never mutation-cache data or a later scope's state.
      if (mounted.current) { setCreated(token); setCopy('idle'); setName(''); }
    },
    onSuccess: refresh,
  });
  const revoke = useMutation({ mutationFn: (id: string) => revokeApiToken(id), onSuccess: refresh });
  const toggle = (scope: ApiTokenScope) => setScopes(current => current.includes(scope) ? current.filter(item => item !== scope) : [...current, scope]);
  const origin = window.location.origin;
  const canCreate = name.trim().length > 0 && scopes.length > 0 && !create.isPending;

  async function copyToken() {
    if (!created) return;
    try { await navigator.clipboard.writeText(created.token); setCopy('ok'); } catch { setCopy('failed'); }
  }

  return <section aria-label={t('apiTokens.title')} className="min-w-0 space-y-5">
    <header className="space-y-2"><h2 className="text-lg font-semibold">{t('apiTokens.title')}</h2><p className="max-w-3xl text-sm text-muted">{t('apiTokens.intro')}</p><a className="text-sm text-accent-ink underline" href="/docs" target="_blank" rel="noreferrer">{t('apiTokens.docsLink')}</a></header>

    {created ? <section aria-label={t('apiTokens.createdTitle')} className="space-y-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-amber-950 [[data-theme=dark]_&]:border-amber-500/40 [[data-theme=dark]_&]:bg-amber-500/10 [[data-theme=dark]_&]:text-amber-100">
      <h3 className="font-semibold">{t('apiTokens.createdTitle')}</h3>
      <p className="text-sm">{t('apiTokens.createdHint')}</p>
      <div className="flex flex-wrap items-center gap-2"><TextInput readOnly aria-label={t('apiTokens.tokenLabel')} value={created.token} className="min-w-0 flex-1 font-mono text-xs" onFocus={event => event.currentTarget.select()}/><Button onClick={() => void copyToken()}>{copy === 'ok' ? <Check size={15} aria-hidden="true"/> : <Copy size={15} aria-hidden="true"/>}{copy === 'ok' ? t('apiTokens.copied') : t('apiTokens.copy')}</Button></div>
      {copy === 'failed' ? <p role="alert" className="text-sm">{t('apiTokens.copyFailed')}</p> : null}
      <div className="space-y-3"><h4 className="text-sm font-semibold">{t('apiTokens.useIt')}</h4>
        <Snippet label={t('apiTokens.labelShell')} text={t('apiTokens.snippetEnv', { origin, token: created.token })}/>
        <Snippet label={t('apiTokens.labelCurl')} text={t('apiTokens.snippetCurl')}/>
        <Snippet label={t('apiTokens.labelClaude')} text={t('apiTokens.snippetClaude', { origin })}/>
        <Snippet label={t('apiTokens.labelCodex')} text={t('apiTokens.snippetCodex', { origin })}/>
      </div>
      <Button variant="primary" onClick={() => setCreated(null)}>{t('apiTokens.done')}</Button>
    </section> : null}

    <form className="space-y-4 rounded-xl border border-line bg-surface p-4" onSubmit={event => { event.preventDefault(); if (canCreate) create.mutate(); }}>
      <h3 className="font-semibold">{t('apiTokens.newToken')}</h3>
      <fieldset disabled={create.isPending} className="grid gap-4 sm:grid-cols-2">
        <label className="grid gap-1 text-xs text-muted sm:col-span-2">{t('apiTokens.name')}<TextInput required maxLength={100} value={name} placeholder={t('apiTokens.namePlaceholder')} onChange={event => setName(event.target.value)}/></label>
        <fieldset className="space-y-2"><legend className="mb-1 text-xs text-muted">{t('apiTokens.access')}</legend>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={scopes.includes('read')} onChange={() => toggle('read')}/>{t('apiTokens.scopeRead')}</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={scopes.includes('tasks:write')} onChange={() => toggle('tasks:write')}/>{t('apiTokens.scopeWrite')}</label>
          {scopes.length === 0 ? <p role="status" className="text-xs text-muted">{t('apiTokens.needScope')}</p> : null}
        </fieldset>
        <fieldset className="space-y-2"><legend className="mb-1 text-xs text-muted">{t('apiTokens.reach')}</legend>
          <label className="flex items-center gap-2 text-sm"><input type="radio" name="api-token-reach" checked={reach === 'all'} onChange={() => setReach('all')}/>{t('apiTokens.reachAll')}</label>
          <label className="flex items-center gap-2 text-sm"><input type="radio" name="api-token-reach" checked={reach === 'this'} onChange={() => setReach('this')}/>{t('apiTokens.reachThis', { name: workspaceName })}</label>
        </fieldset>
        <label className="grid max-w-56 gap-1 text-xs text-muted">{t('apiTokens.expiry')}
          <select className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink" value={days} onChange={event => setDays(Number(event.target.value))}>
            {EXPIRY_DAYS.map(value => <option key={value} value={value}>{dayLabel(value)}</option>)}
          </select>
        </label>
      </fieldset>
      {create.isError ? <p role="alert" className="text-sm text-danger">{describeError(create.error, 'timeOffSave').description}</p> : null}
      <Button type="submit" variant="primary" disabled={!canCreate}>{create.isPending ? t('apiTokens.creating') : t('apiTokens.create')}</Button>
    </form>

    <section aria-label={t('apiTokens.yourTokens')} className="space-y-3">
      <h3 className="font-semibold">{t('apiTokens.yourTokens')}</h3>
      {list.isPending ? <p role="status" className="text-sm text-muted">{t('apiTokens.loading')}</p> : list.isError ? <QueryErrorState error={list.error} subject="workspace" headingLevel={3} onRetry={() => void list.refetch()}/> : list.data.length === 0 ? <p className="text-sm text-muted">{t('apiTokens.none')}</p> :
        <ul className="space-y-2">{list.data.map(token => <TokenRow key={token.id} token={token} busy={revoke.isPending && revoke.variables === token.id} onRevoke={() => revoke.mutate(token.id)}/>)}</ul>}
      {revoke.isError ? <p role="alert" className="text-sm text-danger">{t('apiTokens.failed')}</p> : null}
    </section>
  </section>;
}

function TokenRow({ token, busy, onRevoke }: { token: ApiTokenDto; busy: boolean; onRevoke: () => void }) {
  const { t } = useTranslation();
  const expired = Date.parse(token.expiresAt) <= Date.now();
  const state = token.revokedAt ? 'Revoked' : expired ? 'Expired' : 'Active';
  const scopeText = token.scopes.map(scope => scope === 'read' ? t('apiTokens.scopeReadShort') : t('apiTokens.scopeWriteShort')).join(', ');
  return <li className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-line bg-surface p-3">
    <div className="min-w-0 space-y-1"><p className="flex flex-wrap items-center gap-2 font-medium">{token.name}<Badge tone={state === 'Active' ? 'accent' : 'muted'}>{state === 'Active' ? t('apiTokens.statusActive') : state === 'Expired' ? t('apiTokens.statusExpired') : t('apiTokens.statusRevoked')}</Badge></p>
      <p className="font-mono text-xs text-muted">{token.tokenPrefix}…</p>
      <p className="text-xs text-muted">{t('apiTokens.scopesLine', { scopes: scopeText })} · {token.workspaceIds === null ? t('apiTokens.allWorkspaces') : t('apiTokens.someWorkspaces', { count: token.workspaceIds.length })}</p>
      <p className="text-xs text-muted">{t('apiTokens.created', { date: dateText(token.createdAt) })} · {t('apiTokens.expires', { date: dateText(token.expiresAt) })} · {token.lastUsedAt ? t('apiTokens.lastUsed', { date: dateText(token.lastUsedAt) }) : t('apiTokens.neverUsed')}</p></div>
    {state === 'Active' ? <Button size="sm" aria-label={t('apiTokens.revokeLabel', { name: token.name })} disabled={busy} onClick={onRevoke}>{busy ? t('apiTokens.revoking') : t('apiTokens.revoke')}</Button> : null}
  </li>;
}
