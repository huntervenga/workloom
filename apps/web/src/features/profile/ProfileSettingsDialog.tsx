import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { userSettingsResponseSchema, type MeDto, type UserSettingsDto, type UserTheme } from '@workloom/contracts';
import { Button } from '@workloom/ui';
import { useTranslation } from '../../i18n';
import { apiGet, apiRequest, ApiError } from '../../lib/api';
import { queryKeys } from '../../lib/queryKeys';
import { DialogShell } from '../../shared/DialogShell';
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
    { value: 'default' as const, name: t('profile.themeDefault'), description: t('profile.themeDefaultHint') },
    { value: 'dark' as const, name: t('profile.themeDark'), description: t('profile.themeDarkHint') },
    { value: 'light' as const, name: t('profile.themeLight'), description: t('profile.themeLightHint') },
  ];
  return <DialogShell open title={t('profile.settings')} description={t('profile.description')} onOpenChange={open => { if (!open) onClose(); }}>
    <div className="mt-5 space-y-5">
      <AvatarSettings key={actorId} me={me} />
      {query.isPending ? <p role="status" className="text-sm text-muted">{t('profile.loading')}</p> : null}
      {query.data ? <fieldset disabled={save.isPending || query.isError || save.isError} className="space-y-2">
        <legend className="mb-2 text-sm font-medium text-ink">{t('profile.theme')}</legend>
        {options.map(option => <label key={option.value} className="flex cursor-pointer items-start gap-3 rounded-xl border border-line p-3 hover:bg-canvas has-[:checked]:border-accent has-[:disabled]:cursor-default">
          <input type="radio" name="profile-theme" value={option.value} checked={(save.isPending ? save.variables : query.data.settings.theme) === option.value} onChange={() => save.mutate(option.value)} className="mt-1 accent-accent" />
          <span><span className="block text-sm font-medium text-ink">{option.name}</span><span className="block text-xs leading-relaxed text-muted">{option.description}</span></span>
        </label>)}
      </fieldset> : null}
      {query.isError || save.isError ? <div role="alert" className="space-y-2 text-sm text-ink">
        <p>{save.error instanceof ApiError && save.error.kind === 'conflict' ? t('profile.conflict') : t('profile.failed')}</p>
        <Button size="sm" disabled={query.isFetching} onClick={() => { void reload(); }}>{t('profile.reload')}</Button>
      </div> : <p role="status" className="text-xs text-muted">{save.isPending ? t('profile.saving') : save.isSuccess ? t('profile.saved') : t('profile.autoSave')}</p>}
    </div>
  </DialogShell>;
}
