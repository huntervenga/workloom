import { useTranslation } from '../../i18n';
import * as Dialog from '@radix-ui/react-dialog';
import { useQueryClient } from '@tanstack/react-query';
import { Button, TextInput } from '@workloom/ui';
import { RefreshCw } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { useMatch, useNavigate } from 'react-router';
import { useMe } from '../identity/identity';
import { ApiError } from '../../lib/api';
import { DialogReturnFocus, DialogShell } from '../../shared/DialogShell';
import { WORKSPACE_NAME_MAX, WORKSPACE_TIMEZONE_MAX } from './workspaceCreationApi';
import {
  createdWorkspacePath,
  CreationIdentityChangedError,
  isCurrentCreator,
  WorkspaceCreationController,
  type WorkspaceCreationState,
} from './workspaceCreationController';

export interface WorkspaceCreation {
  /** Only a real account in a shared session may create workspaces; fixture actors never see it. */
  canCreate: boolean;
  /** Shows the dialog. Focus returns to `returnFocus` on close while it is still on screen. */
  show: (returnFocus?: HTMLElement | null) => void;
  /** The workspace just created here, until the app has opened it; see `homeTarget`. */
  createdWorkspaceId: string | null;
}

const unavailable: WorkspaceCreation = { canCreate: false, show: () => undefined, createdWorkspaceId: null };

/**
 * Where home sends the actor for its first workspace. A workspace just created here opens its
 * projects, the same target as the create's own navigation, so a navigation held by another
 * owner's guard keeps that target instead of being replaced by the default overview.
 */
export function homeTarget(workspaceId: string, creation: WorkspaceCreation): string {
  return creation.createdWorkspaceId !== null && creation.createdWorkspaceId.toLowerCase() === workspaceId.toLowerCase()
    ? createdWorkspacePath(workspaceId)
    : `/w/${workspaceId}`;
}

/**
 * Stable markers set by the shell's mobile menu. Its drawer unmounts when an action inside it
 * opens this dialog, so focus returns to the menu trigger, which stays on screen.
 */
const MOBILE_NAV = '[data-mobile-nav]';
const MOBILE_NAV_TRIGGER = '[data-mobile-nav-trigger]';

function returnTargetFor(target: HTMLElement | null): HTMLElement | null {
  if (target?.closest(MOBILE_NAV)) return document.querySelector<HTMLElement>(MOBILE_NAV_TRIGGER) ?? target;
  return target;
}
const WorkspaceCreationContext = createContext<WorkspaceCreation>(unavailable);

/** Outside the provider (for example a standalone chooser) nothing can be created. */
export function useWorkspaceCreation(): WorkspaceCreation {
  return useContext(WorkspaceCreationContext);
}

/**
 * The one owner of the new-workspace draft and command. It wraps the shell frame, so both the
 * desktop and the mobile sidebar (which unmounts when its menu closes) and the empty home page
 * share it, and a pending or unconfirmed create survives every trigger going away.
 */
export function WorkspaceCreationProvider({ children }: { children: ReactNode }) {
  const me = useMe();
  const client = useQueryClient();
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  useEffect(() => {
    navigateRef.current = navigate;
  }, [navigate]);
  const actorId = me.actor.id;
  const canCreate = me.authMode === 'shared' && me.actor.kind === 'real';
  // One controller per actor: a request of a previous actor can never reach this one's state.
  const controller = useMemo(() => new WorkspaceCreationController(client, actorId), [client, actorId]);
  useEffect(() => controller.attach((path) => navigateRef.current(path)), [controller]);
  const returnFocus = useRef<HTMLElement | null>(null);
  const created = useSyncExternalStore(controller.subscribe, () => controller.getSnapshot().created, () => controller.getSnapshot().created);
  const openWorkspaceId = useMatch('/w/:workspaceId/*')?.params.workspaceId ?? null;
  useEffect(() => {
    if (openWorkspaceId !== null) controller.forgetCreated(openWorkspaceId);
  }, [controller, openWorkspaceId, created]);

  const value = useMemo<WorkspaceCreation>(
    () =>
      canCreate
        ? {
            canCreate,
            show: (target) => {
              returnFocus.current = returnTargetFor(target ?? null);
              controller.show();
            },
            createdWorkspaceId: created,
          }
        : unavailable,
    [canCreate, controller, created],
  );

  return (
    <WorkspaceCreationContext.Provider value={value}>
      {children}
      {canCreate ? <WorkspaceCreationDialog controller={controller} returnFocus={returnFocus} /> : null}
    </WorkspaceCreationContext.Provider>
  );
}

/** True while the identity read confirms this same real actor; a covered frame hides the dialog. */
function useCurrentCreator(actorId: string): boolean {
  const client = useQueryClient();
  const subscribe = useCallback((listener: () => void) => client.getQueryCache().subscribe(listener), [client]);
  const snapshot = useCallback(() => isCurrentCreator(client, actorId), [client, actorId]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

function timezoneOptions(): readonly string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: 'timeZone') => string[] };
  try {
    return typeof intl.supportedValuesOf === 'function' ? intl.supportedValuesOf('timeZone') : [];
  } catch {
    return [];
  }
}

interface WorkspaceCreationDialogProps {
  controller: WorkspaceCreationController;
  returnFocus: RefObject<HTMLElement | null>;
}

function WorkspaceCreationDialog({ controller, returnFocus }: WorkspaceCreationDialogProps) {
  const { t } = useTranslation();
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const current = useCurrentCreator(controller.actorId);
  const nameRef = useRef<HTMLInputElement>(null);
  const timezoneRef = useRef<HTMLInputElement>(null);
  const nameId = useId();
  const nameHintId = useId();
  const nameErrorId = useId();
  const timezoneId = useId();
  const timezoneHintId = useId();
  const timezoneErrorId = useId();
  const zonesId = useId();
  const zones = useMemo(timezoneOptions, []);

  const { phase, problems } = state;
  const editing = phase === 'editing';
  // While a command is pending or unconfirmed, the fields show exactly what was sent.
  const shown = state.sent?.input ?? state.draft;
  const nameProblem =
    problems?.name === 'empty'
      ? t('workspace.create.nameRequired')
      : problems?.name === 'tooLong'
        ? t('workspace.create.nameTooLong', { max: WORKSPACE_NAME_MAX })
        : null;
  const timezoneProblem = problems?.timezone ? t('workspace.create.timezoneInvalid') : null;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Only the explicit Retry button resends an unconfirmed command.
    if (!editing) return;
    const focus = controller.submit();
    if (focus === 'name') nameRef.current?.focus();
    else if (focus === 'timezone') timezoneRef.current?.focus();
  };

  return (
    <DialogReturnFocus targetRef={returnFocus}>
      <DialogShell
        title={t('workspace.create.title')}
        description={t('workspace.create.description')}
        open={state.open && current}
        onOpenChange={(next) => (next ? controller.show() : controller.hide())}
      >
        <form noValidate onSubmit={submit} className="mt-5 space-y-4">
          <div>
            <label htmlFor={nameId} className="text-sm font-medium text-ink">
              {t('workspace.create.name')}
            </label>
            <TextInput
              ref={nameRef}
              id={nameId}
              className="mt-1.5"
              value={shown.name}
              maxLength={WORKSPACE_NAME_MAX}
              readOnly={!editing}
              autoComplete="off"
              aria-invalid={nameProblem ? true : undefined}
              aria-describedby={nameProblem ? `${nameErrorId} ${nameHintId}` : nameHintId}
              onChange={(event) => controller.edit({ name: event.target.value })}
            />
            {nameProblem ? (
              <p id={nameErrorId} className="mt-1.5 text-sm text-red-700">
                {nameProblem}
              </p>
            ) : null}
            <p id={nameHintId} className="mt-1.5 text-xs text-subtle">
              {t('common.nameLengthHint', { count: WORKSPACE_NAME_MAX })}
            </p>
          </div>

          <div>
            <label htmlFor={timezoneId} className="text-sm font-medium text-ink">
              {t('workspace.create.timezone')}
            </label>
            <TextInput
              ref={timezoneRef}
              id={timezoneId}
              className="mt-1.5"
              value={shown.timezone}
              maxLength={WORKSPACE_TIMEZONE_MAX}
              readOnly={!editing}
              autoComplete="off"
              spellCheck={false}
              list={zones.length > 0 ? zonesId : undefined}
              aria-invalid={timezoneProblem ? true : undefined}
              aria-describedby={timezoneProblem ? `${timezoneErrorId} ${timezoneHintId}` : timezoneHintId}
              onChange={(event) => controller.edit({ timezone: event.target.value })}
            />
            {zones.length > 0 ? (
              <datalist id={zonesId}>
                {zones.map((zone) => (
                  <option key={zone} value={zone} />
                ))}
              </datalist>
            ) : null}
            {timezoneProblem ? (
              <p id={timezoneErrorId} className="mt-1.5 text-sm text-red-700">
                {timezoneProblem}
              </p>
            ) : null}
            <p id={timezoneHintId} className="mt-1.5 text-xs text-subtle">
              {t('workspace.create.timezoneHint')}
            </p>
          </div>

          <CreationFeedback state={state} />

          <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
            {editing && controller.dirty ? (
              <Button variant="ghost" onClick={() => controller.discard()}>
                {t('workspace.create.discard')}
              </Button>
            ) : null}
            <Dialog.Close asChild>
              <Button>{editing ? t('common.cancel') : t('common.hide')}</Button>
            </Dialog.Close>
            {phase === 'uncertain' ? (
              <Button variant="primary" onClick={() => controller.retry()}>
                <RefreshCw size={16} aria-hidden="true" />
                {t('workspace.create.retry')}
              </Button>
            ) : (
              <Button type="submit" variant="primary" aria-disabled={phase === 'pending' || undefined}>
                {phase === 'pending' ? t('workspace.create.creating') : t('workspace.create.submit')}
              </Button>
            )}
          </div>
        </form>
      </DialogShell>
    </DialogReturnFocus>
  );
}

function CreationFeedback({ state }: { state: WorkspaceCreationState }) {
  const { t } = useTranslation();
  const { error, phase } = state;
  if (error === null || phase === 'pending') return null;
  if (error instanceof CreationIdentityChangedError && phase === 'uncertain') {
    return (
      <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2.5 text-sm leading-relaxed text-ink">
        <p className="font-medium">{t('workspace.create.identityChangedTitle')}</p>
        <p className="mt-1 text-ink-soft">{t('workspace.create.identityChanged')}</p>
      </div>
    );
  }
  if (phase === 'uncertain') {
    return (
      <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2.5 text-sm leading-relaxed text-ink">
        <p className="font-medium">{t('workspace.create.uncertainTitle')}</p>
        <p className="mt-1 text-ink-soft">{t('workspace.create.uncertain')}</p>
      </div>
    );
  }
  return (
    <div role="alert" className="rounded-lg border border-red-200 bg-red-50/60 px-3 py-2.5 text-sm leading-relaxed text-red-800">
      <p className="font-medium">{t('workspace.create.failedTitle')}</p>
      <p className="mt-1">{t(rejectionKey(error))}</p>
    </div>
  );
}

function rejectionKey(error: Error): `workspace.create.${string}` {
  // Refused before sending: this tab no longer has a confirmed session for the same account.
  if (error instanceof CreationIdentityChangedError) return 'workspace.create.signedOut';
  if (!(error instanceof ApiError)) return 'workspace.create.failed';
  switch (error.kind) {
    case 'validation':
    case 'invalid_input':
      return 'workspace.create.rejectedInput';
    case 'forbidden':
      return 'workspace.create.notAllowed';
    case 'unauthenticated':
      return 'workspace.create.signedOut';
    case 'rate_limited':
      return 'workspace.create.rateLimited';
    default:
      return 'workspace.create.failed';
  }
}
