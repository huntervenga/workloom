import { createSectionInputSchema, type SectionDto } from '@workloom/contracts';
import { Button, TextInput } from '@workloom/ui';
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useTranslation } from '../../i18n';
import { useProtectedDraft } from '../../lib/protectedDrafts';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { useCreateSectionMutation } from './queries';

/** Page-owned draft and command survive regrouping, view changes and a hidden composer. */
export function useSectionCreate(actorId: string, workspaceId: string, projectId: string, writable: boolean, presentationKey: string, onCreated: (section: SectionDto) => void) {
  const mutation = useCreateSectionMutation(actorId, workspaceId);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const focusClaim = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const revealLease = useRef<string | null>(null);
  const [revealSectionId, setRevealSectionId] = useState<string | null>(null);
  const head = useRef({ writable, presentationKey });
  const returnFocus = useRef<HTMLButtonElement>(null);
  const sent = mutation.pendingCommand?.variables ?? mutation.uncertain?.variables;
  const held = sent !== undefined;
  useProtectedDraft(name.trim() !== '' && !held);
  useLayoutEffect(() => {
    if (!writable || head.current.presentationKey !== presentationKey) revealLease.current = null;
    head.current = { writable, presentationKey };
  });
  useEffect(() => {
    const outside = (event: Event) => {
      // Removing the submitted form may leave body focused; an actual outside pointer still revokes.
      if (event.type === 'focusin' && event.target === document.body) return;
      if (!(event.target instanceof Node) || !form.current?.contains(event.target)) revealLease.current = null;
    };
    const revoke = () => { revealLease.current = null; };
    document.addEventListener('pointerdown', outside, true); document.addEventListener('focusin', outside, true); window.addEventListener('blur', revoke);
    return () => { revoke(); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('focusin', outside, true); window.removeEventListener('blur', revoke); };
  }, []);
  const success = (section: SectionDto) => {
    if (head.current.writable && revealLease.current === head.current.presentationKey && form.current?.contains(document.activeElement)) setRevealSectionId(section.id);
    else { revealLease.current = null; setRevealSectionId(null); }
    focusClaim.current = false; setOpen(false); setName(''); setInvalid(false); onCreated(section);
  };
  return {
    open, name: sent?.input.name ?? name, invalid, held, returnFocus, mutation, focusRequest, focusClaim, form, revealSectionId,
    claimSectionReveal: () => {
      const allowed = revealSectionId !== null && head.current.writable && revealLease.current === head.current.presentationKey;
      revealLease.current = null;
      setRevealSectionId(null);
      return allowed;
    },
    frozen: held || !writable,
    start: () => { revealLease.current = null; setRevealSectionId(null); focusClaim.current = true; setFocusRequest(before => before + 1); setOpen(true); setInvalid(false); },
    change: (value: string) => { if (!held) { setName(value); setInvalid(false); } },
    cancel: () => {
      focusClaim.current = false;
      revealLease.current = null;
      setRevealSectionId(null);
      setOpen(false);
      if (!held) { setName(''); setInvalid(false); mutation.reset(); }
      returnFocus.current?.focus({ preventScroll: true });
    },
    submit: () => {
      if (!writable || mutation.pendingCommand) return;
      if (mutation.uncertain) {
        setRevealSectionId(null);
        revealLease.current = form.current?.contains(document.activeElement) ? head.current.presentationKey : null;
        mutation.retryUncertain({ onSuccess: success }); return;
      }
      const checked = createSectionInputSchema.safeParse({ name: name.trim() });
      if (!checked.success) { setInvalid(true); return; }
      setRevealSectionId(null);
      revealLease.current = form.current?.contains(document.activeElement) ? head.current.presentationKey : null;
      mutation.mutate({ projectId, input: checked.data }, { onSuccess: success });
    },
  };
}

export type SectionCreateController = ReturnType<typeof useSectionCreate>;

export function SectionCreateForm({ controller, writable }: { controller: SectionCreateController; writable: boolean }) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (!controller.focusClaim.current) return;
    // A query/view remount retains the draft, but only explicit Add/Resume owns focus and scroll.
    controller.focusClaim.current = false;
    input.current?.focus({ preventScroll: true });
    input.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [controller.focusRequest, controller.focusClaim]);
  return <form ref={controller.form} aria-label={t('projects.sectionCreate.form')} noValidate className="space-y-2 py-2" onSubmit={event => { event.preventDefault(); controller.submit(); }} onKeyDown={event => {
    if (event.nativeEvent.isComposing) { if (event.key === 'Enter') event.preventDefault(); return; }
    if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); controller.cancel(); }
  }}>
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <TextInput ref={input} aria-label={t('projects.sectionDialogs.sectionName')} placeholder={t('projects.sectionDialogs.sectionName')} value={controller.name} readOnly={controller.frozen} maxLength={160} aria-invalid={controller.invalid || undefined} onChange={event => controller.change(event.target.value)} className="min-w-0 flex-1 basis-48 font-semibold" />
      <Button size="sm" type="submit" disabled={!writable || controller.mutation.pendingCommand !== null}>{controller.mutation.uncertain ? t('projects.sectionCreate.retrySubmission') : t('projects.sectionCreate.addSection')}</Button>
      <Button size="sm" variant="ghost" type="button" onClick={controller.cancel}>{t('common.cancel')}</Button>
    </div>
    {controller.invalid ? <p role="alert" className="text-xs text-danger">{controller.name.trim() === '' ? t('projects.sectionDialogs.enterASectionName') : t('projects.sectionDialogs.nameMustBeValueCharactersOrFewer', { p0: 160 })}</p> : null}
    <SaveFeedback error={controller.mutation.error} uncertainError={controller.mutation.uncertain?.error ?? null} subject="sectionSave" />
  </form>;
}

export type SectionCreateReturnFocus = RefObject<HTMLButtonElement | null>;
