import {
  projectViewListSchema, projectViewsResponseSchema, setProjectViewsInputSchema,
  type ProjectViewSettings, type SavedProjectView, type SetProjectViewsInput,
} from '@workloom/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, TextInput } from '@workloom/ui';
import { useState, type FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import { apiGet, prepareMutation } from '../../lib/api';
import { queryKeys } from '../../lib/queryKeys';
import { useIdempotentMutation, type IdempotentVariables } from '../../lib/useIdempotentMutation';
import { DialogShell } from '../../shared/DialogShell';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { workspacePath } from '../workspace/queries';

type Scope = 'personal' | 'team';
function readLocal(key: string): SavedProjectView[] {
  try {
    const result = projectViewListSchema.safeParse(JSON.parse(localStorage.getItem(key) ?? '[]'));
    return result.success ? result.data : [];
  } catch { return []; }
}

export function ProjectViewsDialog({ actorId, workspaceId, projectId, canManage, settings, onApply, onClose }: {
  actorId: string; workspaceId: string; projectId: string; canManage: boolean; settings: ProjectViewSettings;
  onApply: (settings: ProjectViewSettings) => void; onClose: () => void;
}) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const key = `workloom.savedViews.v1.${actorId}.${workspaceId}.${projectId}`;
  const [personal, setPersonal] = useState(() => readLocal(key));
  const [scope, setScope] = useState<Scope>('personal');
  const [name, setName] = useState('');
  const [invalid, setInvalid] = useState(false);
  const path = `${workspacePath(workspaceId)}/projects/${projectId}/saved-views`;
  const queryKey = [...queryKeys.workspace(actorId, workspaceId), 'saved-views', projectId] as const;
  const shared = useQuery({ queryKey, queryFn: async ({ signal }) => (await apiGet(path, projectViewsResponseSchema, signal)).data, retry: false });
  const command = useIdempotentMutation({
    prepare: ({ input }: IdempotentVariables & { input: SetProjectViewsInput }) =>
      prepareMutation({ method: 'PUT', path, input, inputSchema: setProjectViewsInputSchema, responseSchema: projectViewsResponseSchema }),
    onSuccess: saved => {
      client.setQueryData(queryKey, saved);
      setName('');
      setInvalid(false);
    },
  });
  const held = command.pendingCommand !== null || command.uncertain !== null;
  const team = shared.isSuccess && shared.data.workspaceId === workspaceId && shared.data.projectId === projectId ? shared.data : null;
  const replace = (kind: Scope, views: SavedProjectView[]) => {
    if (held || !projectViewListSchema.safeParse(views).success) { setInvalid(true); return; }
    if (kind === 'personal') {
      try { localStorage.setItem(key, JSON.stringify(views)); } catch { setInvalid(true); return; }
      setPersonal(views);
      setName('');
      setInvalid(false);
    } else if (canManage && team && !command.hasOtherProtectedCommands()) {
      command.mutate({ input: { expectedRevision: team.revision, views } });
    }
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (held) return;
    const views = scope === 'personal' ? personal : team?.views;
    if (!views) return;
    replace(scope, [...views, { id: crypto.randomUUID(), name: name.trim(), settings }]);
  };
  const renderGroup = (kind: Scope, views: SavedProjectView[]) => <ul className="space-y-1">
    {views.map(view => <li key={view.id} className="flex items-center gap-2 rounded border border-line px-2">
      <button type="button" disabled={held} className="min-w-0 flex-1 truncate py-2 text-left text-sm hover:text-accent-ink disabled:text-muted"
        title={view.name} onClick={() => { onApply(view.settings); onClose(); }}>{view.name}</button>
      {kind === 'personal' || canManage ? <Button type="button" size="sm" variant="ghost" disabled={held}
        aria-label={t('projects.savedViews.removeNamed', { name: view.name })}
        onClick={() => replace(kind, views.filter(item => item.id !== view.id))}>{t('projects.savedViews.remove')}</Button> : null}
    </li>)}
  </ul>;
  return <DialogShell open title={t('projects.savedViews.title')} description={t('projects.savedViews.description')} onOpenChange={open => { if (!open && !held) onClose(); }}>
    <div className="space-y-4">
      <section className="space-y-1"><h3 className="text-sm font-semibold">{t('projects.savedViews.personal')}</h3>
        {personal.length ? renderGroup('personal', personal) : <p className="text-xs text-muted">{t('projects.savedViews.empty')}</p>}
      </section>
      <section className="space-y-1"><h3 className="text-sm font-semibold">{t('projects.savedViews.team')}</h3>
        {shared.isPending ? <p className="text-xs text-muted">{t('projects.savedViews.loading')}</p> :
          team ? team.views.length ? renderGroup('team', team.views) : <p className="text-xs text-muted">{t('projects.savedViews.empty')}</p> :
          <Button type="button" size="sm" variant="ghost" onClick={() => void shared.refetch()}>{t('projects.savedViews.retry')}</Button>}
      </section>
      <form onSubmit={submit} className="space-y-2 border-t border-line pt-3">
        <label className="grid gap-1 text-sm">{t('projects.savedViews.name')}
          <TextInput required maxLength={80} value={name} disabled={held} onChange={event => { setName(event.target.value); setInvalid(false); }} />
        </label>
        {canManage && team ? <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={scope === 'team'} disabled={held} onChange={event => setScope(event.target.checked ? 'team' : 'personal')} />
          {t('projects.savedViews.share')}
        </label> : null}
        {invalid ? <p role="alert" className="text-sm text-danger">{t('projects.savedViews.invalid')}</p> : null}
        <SaveFeedback error={command.error} uncertainError={command.uncertain?.error ?? null} subject="projectSave" />
        {command.uncertain ? <Button type="button" disabled={command.pendingCommand !== null} onClick={() => command.retryUncertain()}>{t('common.retry')}</Button> :
          <Button type="submit" disabled={held || !name.trim() || scope === 'team' && (!team || !canManage)}>{t('projects.savedViews.save')}</Button>}
        {command.error && !command.uncertain ? <Button type="button" variant="ghost" onClick={() => void shared.refetch()}>{t('projects.savedViews.reload')}</Button> : null}
      </form>
    </div>
  </DialogShell>;
}
