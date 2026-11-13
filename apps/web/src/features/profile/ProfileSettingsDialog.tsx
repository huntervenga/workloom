import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { userSettingsResponseSchema, type MeDto, type UserSettingsDto, type UserTheme } from '@workloom/contracts';
import { Button } from '@workloom/ui';
import { useTranslation } from '../../i18n';
import { apiGet, apiRequest, ApiError } from '../../lib/api';
import { queryKeys } from '../../lib/queryKeys';
import { DialogShell } from '../../shared/DialogShell';
import { desktopPalettes } from '../theme/palettes';
import { AvatarSettings } from './AvatarSettings';

function accept(client: QueryClient, actorId: string, settings: UserSettingsDto) {
  client.setQueryData<MeDto>(queryKeys.me, previous => {
    if (!previous || previous.actor.id !== actorId || settings.userId !== actorId) return previous;
    if ((previous.settings?.revision ?? -1) >= settings.revision) return previous;
    return { ...previous, settings };
  });
}

export function ProfileSettingsDialog({ me, onClose }: { me: MeDto; onClose: () => void }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'profile' | 'appearance'>('profile');
  const client = useQueryClient(), actorId = me.actor.id;
  const key = ['actor', actorId, 'profile-settings'] as const;
  const query = useQuery({ queryKey: key, initialData: me.settings, queryFn: async ({ signal }) => {
    const { data } = await apiGet('/api/v1/me/settings', userSettingsResponseSchema, signal);
    if (data.userId !== actorId) throw new ApiError({ kind: 'unauthenticated', status: 401 });
    return data;
  } });
  useEffect(() => { if (query.data) accept(client, actorId, query.data); }, [client, actorId, query.data]);
  const save = useMutation({
    mutationFn: async (theme: UserTheme) => {
      if (!query.data) throw new ApiError({ kind: 'invalid_input', status: null });
      await client.cancelQueries({ queryKey: key });
      const response = await apiRequest('/api/v1/me/settings', { method: 'PATCH', body: { expectedUserId: actorId, expectedRevision: query.data.revision, settings: { theme } } });
      const parsed = userSettingsResponseSchema.safeParse(response.payload);
      if (!parsed.success || parsed.data.data.userId !== actorId) throw new ApiError({ kind: 'invalid_response', status: response.status });
      return parsed.data.data;
    },
    onSuccess: saved => {
      // An old account's response must never recolor the new account after a switch.
      if (client.getQueryData<MeDto>(queryKeys.me)?.actor.id !== actorId) return;
      client.setQueryData(key, saved); accept(client, actorId, saved);
    },
  });
  const reload = async () => { const result = await query.refetch(); if (result.isSuccess) save.reset(); };
  const options = [
    { id: 'dark' as const, name: t('profile.themeDark'), description: t('profile.themeDarkHint'), mode: 'dark', canvas: '#0d1117', surface: '#161b22', ink: '#e6edf3', accent: '#a5b4fc', line: '#30363d' },
    { id: 'light' as const, name: t('profile.themeLight'), description: t('profile.themeLightHint'), mode: 'light', canvas: '#f8fafc', surface: '#ffffff', ink: '#0f172a', accent: '#5b5ee0', line: '#e2e8f0' },
    ...desktopPalettes.map(palette => ({ ...palette, description: '' })),
  ];
  const selected = save.isPending ? save.variables : query.data?.settings.theme;
  return <DialogShell open variant="wide" title={t('profile.settings')} description={t('profile.description')} onOpenChange={open => { if (!open) onClose(); }}>
    <div className="mt-5 space-y-5">
      <div className="flex gap-2 border-b border-line pb-3" aria-label={t('profile.settings')}>
        <Button size="sm" variant={tab === 'profile' ? 'primary' : 'ghost'} aria-pressed={tab === 'profile'} onClick={() => setTab('profile')}>{t('profile.profileTab')}</Button>
        <Button size="sm" variant={tab === 'appearance' ? 'primary' : 'ghost'} aria-pressed={tab === 'appearance'} onClick={() => setTab('appearance')}>{t('profile.appearanceTab')}</Button>
      </div>
      {tab === 'profile' ? <AvatarSettings key={actorId} me={me} /> : null}
      <div hidden={tab !== 'appearance'} className="space-y-4">
      {query.isPending ? <p role="status" className="text-sm text-muted">{t('profile.loading')}</p> : null}
      {query.data ? <fieldset disabled={save.isPending || query.isError || save.isError} className="space-y-2">
        <legend className="mb-2 text-sm font-medium text-ink">{t('profile.theme')}</legend>
        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line p-3 has-[:checked]:border-accent">
          <input type="radio" name="profile-theme" checked={selected === 'default'} onChange={() => save.mutate('default')} className="mt-1 accent-accent" />
          <span><span className="block text-sm font-medium text-ink">{t('profile.themeDefault')}</span><span className="block text-xs text-muted">{t('profile.themeDefaultHint')}</span></span>
        </label>
        {(['dark', 'light'] as const).map(mode => <div key={mode} className="pt-4">
          <h3 className="mb-3 text-xs font-semibold tracking-widest text-muted">{mode === 'dark' ? t('profile.darkGroup') : t('profile.lightGroup')}</h3>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {options.filter(option => option.mode === mode).map(option => <label key={option.id} className="min-w-0 cursor-pointer rounded-xl border border-line p-2 hover:border-accent has-[:checked]:border-accent has-[:checked]:ring-1 has-[:checked]:ring-accent has-[:disabled]:cursor-default">
              <span aria-hidden="true" className="mb-2 flex h-20 overflow-hidden rounded-lg border" style={{ background: option.canvas, borderColor: option.line }}>
                <span className="flex w-1/4 flex-col gap-2 border-r p-2" style={{ background: option.surface, borderColor: option.line }}>
                  <span className="h-2 w-3 rounded-sm" style={{ background: option.accent }} />
                  {[0, 1, 2].map(i => <span key={i} className="h-1 w-full rounded" style={{ background: option.ink, opacity: 0.25 }} />)}
                </span>
                <span className="flex flex-1 flex-col gap-2 p-2">
                  <span className="h-1.5 w-2/3 rounded" style={{ background: option.ink }} />
                  {[0, 1, 2].map(i => <span key={i} className="flex items-center gap-1 border-b pb-1" style={{ borderColor: option.line }}><span className="size-1.5 rounded-sm" style={{ background: option.accent }} /><span className="h-1 flex-1 rounded" style={{ background: option.ink, opacity: 0.3 }} /></span>)}
                </span>
              </span>
              <span className="flex items-start gap-2 px-1 pb-1">
                <input type="radio" name="profile-theme" value={option.id} checked={selected === option.id} onChange={() => save.mutate(option.id)} className="mt-0.5 shrink-0 accent-accent" />
                <span className="text-xs font-medium text-ink">{option.name}{option.description ? <span className="sr-only"> {option.description}</span> : null}</span>
              </span>
            </label>)}
          </div>
        </div>)}
      </fieldset> : null}
      {query.isError || save.isError ? <div role="alert" className="space-y-2 text-sm text-ink">
        <p>{save.error instanceof ApiError && save.error.kind === 'conflict' ? t('profile.conflict') : t('profile.failed')}</p>
        <Button size="sm" disabled={query.isFetching} onClick={() => { void reload(); }}>{t('profile.reload')}</Button>
      </div> : <p role="status" className="text-xs text-muted">{save.isPending ? t('profile.saving') : save.isSuccess ? t('profile.saved') : t('profile.autoSave')}</p>}
      </div>
    </div>
  </DialogShell>;
}
