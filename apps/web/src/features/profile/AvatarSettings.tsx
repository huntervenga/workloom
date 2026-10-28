import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MAX_AVATAR_BYTES, serverFeaturesResponseSchema, userAvatarResponseSchema, type MeDto, type UserAvatarDto } from '@workloom/contracts';
import { Button } from '@workloom/ui';
import { apiGet, apiRequest, ApiError } from '../../lib/api';
import { queryKeys } from '../../lib/queryKeys';
import { useTranslation } from '../../i18n';
import { UserAvatar } from '../../shared/UserAvatar';

export function AvatarSettings({ me }: { me: MeDto }) {
  const { t } = useTranslation(), client = useQueryClient(), actorId = me.actor.id;
  const key = ['actor', actorId, 'avatar-settings'] as const;
  const input = useRef<HTMLInputElement>(null), controller = useRef<AbortController | null>(null);
  const [validation, setValidation] = useState<'large' | 'type' | null>(null);
  const features = useQuery({ queryKey: ['server-features', 'avatars', actorId], retry: false, staleTime: 60_000,
    queryFn: async ({ signal }) => (await apiGet('/api/v1/features', serverFeaturesResponseSchema, signal)).data.features.userAvatars ?? null });
  const profile = useQuery({ queryKey: key, retry: false, queryFn: async ({ signal }) => {
    const response = await apiGet('/api/v1/me/avatar', userAvatarResponseSchema, signal);
    if (response.data.userId !== actorId) throw new ApiError({ kind: 'unauthenticated', status: 401 });
    return response.data;
  } });
  useEffect(() => () => { controller.current?.abort(); }, []);
  const accept = (value: UserAvatarDto) => {
    if (client.getQueryData<MeDto>(queryKeys.me)?.actor.id !== actorId || value.userId !== actorId) return;
    const cached = client.getQueryData<UserAvatarDto>(key);
    if (cached && cached.revision > value.revision) return;
    client.setQueryData(key, value);
    client.setQueryData<MeDto>(queryKeys.me, previous => previous && previous.actor.id === actorId
      ? { ...previous, actor: { ...previous.actor, avatarUrl: value.avatarUrl } } : previous);
    // Person photos occur in membership, comment, activity, report and time-off projections.
    void client.invalidateQueries({ queryKey: queryKeys.actor(actorId) });
    void client.invalidateQueries({ queryKey: queryKeys.me });
  };
  const save = useMutation({ mutationFn: async (file: File | null) => {
    if (!profile.data || client.getQueryData<MeDto>(queryKeys.me)?.actor.id !== actorId) throw new ApiError({ kind: 'unauthenticated', status: 401 });
    await client.cancelQueries({ queryKey: key });
    const abort = new AbortController(); controller.current = abort;
    const result = await apiRequest('/api/v1/me/avatar', file ? {
      method: 'PUT', binaryBody: file, signal: abort.signal,
      headers: { 'X-Workloom-Expected-Actor': actorId, 'X-Workloom-Avatar-Revision': String(profile.data.revision) },
    } : { method: 'DELETE', signal: abort.signal, body: { expectedUserId: actorId, expectedRevision: profile.data.revision } });
    const parsed = userAvatarResponseSchema.safeParse(result.payload);
    if (!parsed.success || parsed.data.data.userId !== actorId) throw new ApiError({ kind: 'invalid_response', status: result.status });
    return parsed.data.data;
  }, onSuccess: accept });
  const reload = async () => { const result = await profile.refetch(); if (result.isSuccess && result.data) { save.reset(); setValidation(null); accept(result.data); } };
  const enabled = features.data?.enabled === true;
  const disabled = !enabled || !profile.data || profile.isError || save.isPending || save.isError;
  const choose = (file?: File) => {
    if (!file || disabled) return;
    setValidation(null);
    if (file.size > (features.data?.maxFileSizeBytes ?? MAX_AVATAR_BYTES)) { setValidation('large'); return; }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) { setValidation('type'); return; }
    save.mutate(file);
  };
  const problem = validation === 'large' ? t('profile.avatarTooLarge') : validation === 'type' ? t('profile.avatarInvalid')
    : save.error instanceof ApiError && save.error.kind === 'conflict' ? t('profile.avatarConflict')
    : save.error instanceof ApiError && save.error.code === 'AVATAR_INVALID_IMAGE' ? t('profile.avatarInvalid') : t('profile.avatarFailed');
  return <section aria-label={t('profile.avatar')} className="space-y-3">
    <div className="flex items-center gap-3"><UserAvatar name={me.actor.displayName} seed={actorId} avatarUrl={profile.data ? profile.data.avatarUrl : me.actor.avatarUrl} size="lg" />
      <div className="min-w-0"><p className="break-words font-medium text-ink">{me.actor.displayName}</p><p className="text-xs text-muted">{t('profile.avatarHelp')}</p></div>
    </div>
    <input ref={input} type="file" className="sr-only" tabIndex={-1} aria-label={t('profile.chooseAvatar')} accept="image/jpeg,image/png,image/webp" disabled={disabled}
      onChange={event => { choose(event.currentTarget.files?.[0]); event.currentTarget.value = ''; }} />
    <div className="flex flex-wrap gap-2"><span title={!enabled ? t('profile.avatarUnavailable') : undefined} className="inline-flex">
      <Button size="sm" disabled={disabled} onClick={() => input.current?.click()}>{save.isPending ? t('profile.avatarSaving') : profile.data?.hasCustomAvatar ? t('profile.changeAvatar') : t('profile.uploadAvatar')}</Button>
    </span>{profile.data?.hasCustomAvatar ? <Button size="sm" variant="ghost" disabled={save.isPending || save.isError || profile.isError} onClick={() => { setValidation(null); save.mutate(null); }}>{t('profile.removeAvatar')}</Button> : null}</div>
    {!enabled ? <p className="text-xs text-muted">{features.isPending ? t('profile.avatarChecking') : features.isError ? t('profile.avatarFeatureFailed') : t('profile.avatarUnavailable')}</p> : null}
    {validation || save.isError || (profile.isError && enabled) ? <div role="alert" className="space-y-2 text-sm text-ink"><p>{problem}</p>
      {save.isError || profile.isError ? <Button size="sm" disabled={profile.isFetching} onClick={() => { void reload(); }}>{t('profile.avatarReload')}</Button> : null}
    </div> : save.isSuccess ? <p role="status" className="text-xs text-muted">{t('profile.avatarSaved')}</p> : null}
  </section>;
}
