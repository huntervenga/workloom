import { createSectionInputSchema, type SectionDto } from '@workloom/contracts';
import { Button } from '@workloom/ui';
import { RefreshCw } from 'lucide-react';
import { useState, type ReactElement } from 'react';
import { ApiError } from '../../lib/api';
import { DialogShell } from '../../shared/DialogShell';
import { NameForm } from '../../shared/NameForm';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { useCreateSectionMutation, useReloadSections, type useUpdateSectionMutation } from './queries';

/** Same limit as the section name in @workloom/contracts, which remains the authority. */
const SECTION_NAME_MAX = 160;

function sectionNameProblem(name: string): string | null {
  if (createSectionInputSchema.safeParse({ name }).success) return null;
  if (name.trim() === '') return 'Введите название раздела.';
  return `Название должно быть не длиннее ${SECTION_NAME_MAX} символов.`;
}

export interface CreateSectionDialogProps {
  actorId: string;
  workspaceId: string;
  projectId: string;
  trigger: ReactElement;
  onCreated?: ((section: SectionDto) => void) | undefined;
}

/** Keeps its mutation while closed, so an uncertain create survives reopening. */
export function CreateSectionDialog({ actorId, workspaceId, projectId, trigger, onCreated }: CreateSectionDialogProps) {
  const [open, setOpen] = useState(false);
  const mutation = useCreateSectionMutation(actorId, workspaceId);
  const sent = mutation.isPending ? mutation.variables : mutation.uncertain?.variables;
  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (!next && !mutation.isPending) mutation.reset();
  };
  const onSuccess = (section: SectionDto) => {
    changeOpen(false);
    onCreated?.(section);
  };

  return (
    <DialogShell
      title="Новый раздел"
      description="Раздел группирует задачи проекта. Название можно изменить позже."
      trigger={trigger}
      open={open}
      onOpenChange={changeOpen}
    >
      <NameForm
        label="Название раздела"
        initialName=""
        maxLength={SECTION_NAME_MAX}
        validate={sectionNameProblem}
        submitLabel="Создать раздел"
        pending={mutation.isPending}
        locked={mutation.uncertain !== null}
        sentName={sent?.input.name}
        onRetry={() => mutation.retryUncertain({ onSuccess })}
        feedback={
          <SaveFeedback error={mutation.error} uncertainError={mutation.uncertain?.error ?? null} subject="sectionSave" />
        }
        onSubmit={(name) => mutation.mutate({ projectId, input: { name } }, { onSuccess })}
      />
    </DialogShell>
  );
}

export interface RenameSectionDialogProps {
  actorId: string;
  workspaceId: string;
  /** The section to rename, or null when closed. */
  section: SectionDto | null;
  /** Owned by the page, so an uncertain rename survives closing the dialog. */
  mutation: ReturnType<typeof useUpdateSectionMutation>;
  onClose: () => void;
  onRenamed?: ((section: SectionDto) => void) | undefined;
}

/** Opened from the task table; focus returns to the control that opened it. */
export function RenameSectionDialog({ actorId, workspaceId, section, mutation, onClose, onRenamed }: RenameSectionDialogProps) {
  const changeOpen = (next: boolean) => {
    if (next) return;
    onClose();
    if (!mutation.isPending) mutation.reset();
  };

  return (
    <DialogShell
      title="Переименовать раздел"
      description={section ? `Раздел «${section.name}». Новое название увидят все участники пространства.` : ''}
      open={section !== null}
      onOpenChange={changeOpen}
    >
      {section ? (
        <RenameSectionForm
          key={section.id}
          actorId={actorId}
          workspaceId={workspaceId}
          section={section}
          mutation={mutation}
          onDone={(renamed) => {
            changeOpen(false);
            if (renamed) onRenamed?.(renamed);
          }}
        />
      ) : null}
    </DialogShell>
  );
}

interface RenameSectionFormProps {
  actorId: string;
  workspaceId: string;
  section: SectionDto;
  mutation: ReturnType<typeof useUpdateSectionMutation>;
  onDone: (renamed: SectionDto | null) => void;
}

/**
 * The revision is captured at opening; a conflict needs an explicit reload. The mutation is shared
 * by all sections, so while it carries another section's command this form is blocked.
 */
function RenameSectionForm({ actorId, workspaceId, section, mutation, onDone }: RenameSectionFormProps) {
  const reloadSections = useReloadSections(actorId, workspaceId);
  const [base, setBase] = useState({ revision: section.revision, name: section.name });
  const [reload, setReload] = useState<'idle' | 'loading' | 'done' | 'failed' | 'missing'>('idle');
  const command = mutation.isPending ? mutation.variables : mutation.uncertain?.variables;
  const own = command?.sectionId === section.id;
  const otherTarget = command !== undefined && !own;
  const uncertain = own ? mutation.uncertain : null;
  const error = mutation.variables?.sectionId === section.id ? mutation.error : null;
  const conflict = error instanceof ApiError && error.kind === 'conflict';
  const otherNotice = !otherTarget
    ? null
    : mutation.isPending
      ? 'Сохраняется переименование другого раздела. Этот раздел можно будет переименовать после ответа сервера.'
      : 'Переименование другого раздела не подтверждено. Сначала откройте тот раздел и повторите отправку.';

  const loadLatest = async () => {
    if (reload === 'loading') return;
    setReload('loading');
    try {
      const fresh = (await reloadSections(section.projectId)).find((item) => item.id === section.id);
      if (!fresh) {
        setReload('missing');
        return;
      }
      setBase({ revision: fresh.revision, name: fresh.name });
      mutation.reset();
      setReload('done');
    } catch {
      setReload('failed');
    }
  };

  return (
    <NameForm
      label="Название раздела"
      initialName={section.name}
      maxLength={SECTION_NAME_MAX}
      validate={sectionNameProblem}
      submitLabel="Сохранить"
      pending={mutation.isPending && own}
      locked={uncertain !== null}
      sentName={own ? command?.input.name : null}
      blocked={otherTarget}
      onRetry={() => mutation.retryUncertain({ onSuccess: (renamed) => onDone(renamed) })}
      feedback={
        <SaveFeedback
          error={error}
          uncertainError={uncertain?.error ?? null}
          subject="sectionSave"
          action={
            conflict ? (
              <Button size="sm" aria-disabled={reload === 'loading' || undefined} onClick={() => void loadLatest()}>
                <RefreshCw size={16} aria-hidden="true" className={reload === 'loading' ? 'motion-safe:animate-spin' : undefined} />
                Загрузить актуальную версию
              </Button>
            ) : null
          }
        />
      }
      notice={
        otherNotice ??
        (reload === 'done'
          ? `Загружена актуальная версия: «${base.name}». Ваше название осталось в поле — сохраните его, если оно всё ещё нужно.`
          : reload === 'failed'
            ? 'Не удалось загрузить актуальную версию раздела. Повторите попытку.'
            : reload === 'missing'
              ? 'Раздел больше недоступен.'
              : null)
      }
      onSubmit={(name) => {
        if (name === base.name) {
          onDone(null);
          return;
        }
        mutation.mutate(
          { sectionId: section.id, input: { expectedRevision: base.revision, name } },
          { onSuccess: (renamed) => onDone(renamed) },
        );
      }}
    />
  );
}
