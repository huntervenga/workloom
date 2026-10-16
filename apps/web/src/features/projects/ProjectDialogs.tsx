import { t, useTranslation } from '../../i18n';
import { createProjectInputSchema, type ProjectDto } from '@workloom/contracts';
import { Button } from '@workloom/ui';
import { RefreshCw } from 'lucide-react';
import { useState, type ReactElement } from 'react';
import { ApiError } from '../../lib/api';
import { DialogShell } from '../../shared/DialogShell';
import { NameForm } from '../../shared/NameForm';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { useCreateProjectMutation, useReloadProject, useUpdateProjectMutation } from './queries';

/** Same limit as the project name in @workloom/contracts, which remains the authority. */
const PROJECT_NAME_MAX = 160;

function projectNameProblem(name: string): string | null {
  if (createProjectInputSchema.safeParse({ name }).success) return null;
  if (name.trim() === '') return t('projects.projectDialogs.enterAProjectName');
  return t('projects.projectDialogs.nameMustBeValueCharactersOrFewer', { p0: PROJECT_NAME_MAX });
}

export interface CreateProjectDialogProps {
  actorId: string;
  workspaceId: string;
  trigger: ReactElement;
  onCreated?: ((project: ProjectDto) => void) | undefined;
}

/**
 * The mutation lives outside the dialog content, so resubmitting the same name
 * after a failure, even after closing and reopening, reuses its Idempotency-Key.
 * While the command is pending or its outcome is unknown the sent name stays locked in the form.
 */
export function CreateProjectDialog({ actorId, workspaceId, trigger, onCreated }: CreateProjectDialogProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const mutation = useCreateProjectMutation(actorId, workspaceId);
  const sent = mutation.isPending ? mutation.variables : mutation.uncertain?.variables;
  const changeOpen = (next: boolean) => {
    setOpen(next);
    // A pending write keeps its state so reopening shows how it ended.
    if (!next && !mutation.isPending) mutation.reset();
  };
  const onSuccess = (project: ProjectDto) => {
    changeOpen(false);
    onCreated?.(project);
  };

  return (
    <DialogShell
      title={t('projects.projectDialogs.newProject')}
      description={t('projects.projectDialogs.keepYourTeamSTasksTogetherYouCan')}
      trigger={trigger}
      open={open}
      onOpenChange={changeOpen}
    >
      <NameForm
        label={t('projects.projectDialogs.projectName')}
        initialName=""
        maxLength={PROJECT_NAME_MAX}
        validate={projectNameProblem}
        submitLabel={t('projects.projectDialogs.createProject')}
        pending={mutation.isPending}
        locked={mutation.uncertain !== null}
        sentName={sent?.input.name}
        onRetry={() => mutation.retryUncertain({ onSuccess })}
        feedback={
          <SaveFeedback error={mutation.error} uncertainError={mutation.uncertain?.error ?? null} subject="projectSave" />
        }
        onSubmit={(name) => mutation.mutate({ input: { name } }, { onSuccess })}
      />
    </DialogShell>
  );
}

export interface RenameProjectDialogProps {
  actorId: string;
  workspaceId: string;
  project: ProjectDto;
  trigger: ReactElement;
  onRenamed?: ((project: ProjectDto) => void) | undefined;
}

export function RenameProjectDialog({ actorId, workspaceId, project, trigger, onRenamed }: RenameProjectDialogProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const mutation = useUpdateProjectMutation(actorId, workspaceId);
  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (!next && !mutation.isPending) mutation.reset();
  };

  return (
    <DialogShell
      title={t('projects.projectDialogs.renameProject')}
      description={t('projects.projectDialogs.allWorkspaceMembersWillSeeTheNewName')}
      trigger={trigger}
      open={open}
      onOpenChange={changeOpen}
    >
      <RenameProjectForm
        actorId={actorId}
        workspaceId={workspaceId}
        project={project}
        mutation={mutation}
        onDone={(renamed) => {
          changeOpen(false);
          if (renamed) onRenamed?.(renamed);
        }}
      />
    </DialogShell>
  );
}

interface RenameProjectFormProps {
  actorId: string;
  workspaceId: string;
  project: ProjectDto;
  mutation: ReturnType<typeof useUpdateProjectMutation>;
  onDone: (renamed: ProjectDto | null) => void;
}

/**
 * The revision is captured when the dialog opens, so a background refresh can
 * never make the save overwrite a change the user has not seen.
 */
function RenameProjectForm({ actorId, workspaceId, project, mutation, onDone }: RenameProjectFormProps) {
  const { t } = useTranslation();
  const reloadProject = useReloadProject(actorId, workspaceId);
  const [base, setBase] = useState({ revision: project.revision, name: project.name });
  const [reload, setReload] = useState<'idle' | 'loading' | 'done' | 'failed'>('idle');
  const conflict = mutation.error instanceof ApiError && mutation.error.kind === 'conflict';
  const { uncertain } = mutation;
  const sent = mutation.isPending ? mutation.variables : uncertain?.variables;

  const loadLatest = async () => {
    if (reload === 'loading') return;
    setReload('loading');
    try {
      const fresh = await reloadProject(project.id);
      setBase({ revision: fresh.revision, name: fresh.name });
      mutation.reset();
      setReload('done');
    } catch {
      setReload('failed');
    }
  };

  return (
    <NameForm
      label={t('projects.projectDialogs.projectName')}
      initialName={project.name}
      maxLength={PROJECT_NAME_MAX}
      validate={projectNameProblem}
      submitLabel={t('projects.projectDialogs.save')}
      pending={mutation.isPending}
      locked={uncertain !== null}
      sentName={sent?.input.name}
      onRetry={() => mutation.retryUncertain({ onSuccess: (renamed) => onDone(renamed) })}
      feedback={
        <SaveFeedback
          error={mutation.error}
          uncertainError={uncertain?.error ?? null}
          subject="projectSave"
          action={
            conflict ? (
              <Button size="sm" aria-disabled={reload === 'loading' || undefined} onClick={() => void loadLatest()}>
                <RefreshCw size={16} aria-hidden="true" className={reload === 'loading' ? 'motion-safe:animate-spin' : undefined} />
                {t('projects.projectDialogs.loadLatestVersion')}</Button>
            ) : null
          }
        />
      }
      notice={
        reload === 'done'
          ? t('projects.projectDialogs.latestVersionLoadedValueYourNameRemainsIn', { p0: base.name })
          : reload === 'failed'
            ? t('projects.projectDialogs.couldNotLoadTheLatestProjectTryAgain')
            : null
      }
      onSubmit={(name) => {
        if (name === base.name) {
          onDone(null);
          return;
        }
        mutation.mutate(
          { projectId: project.id, input: { expectedRevision: base.revision, name } },
          { onSuccess: (renamed) => onDone(renamed) },
        );
      }}
    />
  );
}
