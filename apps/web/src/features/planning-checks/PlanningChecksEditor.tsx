import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@workloom/ui';
import { planningCheckConfigSchema, planningCheckRuleSchema, type GenericHeaderWidgetGroupDto, type MembershipDto, type PlanningCheckConfigDto, type PlanningCheckRuleDto, type PlanningCheckSettingsDto, type SectionDto, type TagDto, type TaskFieldDefinitionDto } from '@workloom/contracts';
import { useTranslation } from '../../i18n';
import { DialogShell } from '../../shared/DialogShell';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { canonicalJson } from '../../lib/idempotency';
import { useProtectedDraft } from '../../lib/protectedDrafts';
import { usePlanningCheckCommands } from './queries';
import { checkKind, sameCheckGroup } from './presentation';
import { newPlanningRule, PlanningCheckRuleForm, type CheckFocus } from './PlanningCheckRuleForm';
import { ReportSelect } from '../generic-reports/ReportConfigEditor';
import { Link } from 'react-router';
import type { SummaryTemplateWorkspace } from '../summary-templates/queries';
import { SummaryTemplateControls } from '../summary-templates/SummaryTemplateControls';

// Filters are sets. Selecting and then unselecting an option must restore a clean draft,
// even when those selections were made in a different order from the stored config.
function ruleFingerprint(rule: PlanningCheckRuleDto): string {
  return canonicalJson({ ...rule, ...(rule.kind === 'presence' ? { requireBeforeDone: 'requireBeforeDone' in rule && rule.requireBeforeDone === true } : {}), filters: { ...rule.filters, statusGroups: [...rule.filters.statusGroups].sort(), tagIds: [...rule.filters.tagIds].sort() } });
}
function configFingerprint(config: PlanningCheckConfigDto): string {
  return canonicalJson({ enabled: config.enabled, rules: config.rules.map(ruleFingerprint) });
}
function initialRule(settings: PlanningCheckSettingsDto, focus?: CheckFocus): PlanningCheckRuleDto | null {
  // Opening a section is navigation, not a request to start a balance-rule draft.
  // An eager draft used to disable every existing rule's Edit and Remove actions.
  if (!focus || !('fieldId' in focus)) return null;
  const existing = settings.config.rules.find(rule => rule.kind === 'presence' && rule.fieldId === focus.fieldId);
  return existing ? structuredClone(existing) : newPlanningRule('presence', focus);
}

// This component mounts inside Radix's lazy portal, so its layout effect runs only
// after the actual confirmation DOM exists (an effect on the editor runs too early).
function DiscardCheckSettingsActions({ held, onDiscard, onKeepEditing }: { held: boolean; onDiscard: () => void; onKeepEditing: () => void }) {
  const { t } = useTranslation();
  const actions = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const dialog = actions.current?.closest('[role="dialog"]');
    const view = dialog?.ownerDocument.defaultView;
    if (!dialog || !view) return;
    // Radix hands Escape ownership over in a passive effect. The visible decision
    // owns Escape immediately, before a stale parent document listener can claim it.
    const keepEditingOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || !dialog.isConnected || dialog.closest('[aria-hidden="true"]')) return;
      event.preventDefault();
      event.stopPropagation();
      onKeepEditing();
    };
    view.addEventListener('keydown', keepEditingOnEscape, true);
    return () => view.removeEventListener('keydown', keepEditingOnEscape, true);
  }, [onKeepEditing]);
  return <div ref={actions} className="mt-5 flex flex-wrap justify-end gap-2">
    <Button variant="secondary" disabled={held} className="hover:bg-danger-soft/25" style={{ color: 'var(--color-danger-line)', borderColor: 'var(--color-danger-line)' }} onClick={onDiscard}>{t('planningChecks.discard')}</Button>
    <Button variant="primary" onClick={onKeepEditing}>{t('planningChecks.keepEditing')}</Button>
  </div>;
}

export function PlanningChecksEditor({ actorId, workspaceId, projectId, settings, fields, members, sections, tags, focus, onClose, writable, templateController }: {
  writable: boolean; actorId: string; workspaceId: string; projectId: string;
  settings: PlanningCheckSettingsDto; fields: readonly TaskFieldDefinitionDto[];
  members: readonly MembershipDto[]; sections: readonly SectionDto[]; tags: readonly TagDto[];
  focus?: CheckFocus; onClose: () => void; templateController?: SummaryTemplateWorkspace;
}) {
  const { t } = useTranslation();
  const [revision] = useState(settings.revision);
  const [baseline] = useState(() => configFingerprint(settings.config));
  const [config, setConfig] = useState<PlanningCheckConfigDto>(() => structuredClone(settings.config));
  const [ruleDraft, setRuleDraft] = useState(() => {
    const value = initialRule(settings, focus);
    return value ? { value, baseline: ruleFingerprint(value) } : null;
  });
  const [confirmDiscard, setConfirmDiscard] = useState<'editor' | 'rule' | null>(null);
  const [heldCloseNotice, setHeldCloseNotice] = useState<unknown>(null);
  const [kind, setKind] = useState<PlanningCheckRuleDto['kind']>(focus && 'group' in focus ? 'balance' : 'presence');
  const [templateDirty, setTemplateDirty] = useState(false);
  const [handoff, setHandoff] = useState<{ group: GenericHeaderWidgetGroupDto; key: number } | null>(null);
  const activateTemplates = templateController?.activate;
  useEffect(() => { activateTemplates?.(); }, [activateTemplates]);
  const commands = usePlanningCheckCommands(actorId, workspaceId, projectId), command = commands.settings;
  const templateCommand = templateController?.command;
  const templateHeld = templateCommand !== undefined && (templateCommand.pendingCommand !== null || templateCommand.uncertain !== null);
  const held = command.pendingCommand !== null || command.uncertain !== null || templateHeld;
  const heldVariables = command.pendingCommand?.variables ?? command.uncertain?.variables ?? templateCommand?.pendingCommand?.variables ?? templateCommand?.uncertain?.variables;
  const disabled = held || !writable;
  const catalog = templateController?.catalog;
  const templateData = catalog?.isSuccess && !catalog.isError ? catalog.data : undefined;
  const ownershipKnown = Boolean(templateData && !catalog?.isFetching);
  const managedBy = (rule: PlanningCheckRuleDto) => rule.kind === 'balance' ? templateData?.bindings.find(binding => !binding.detached && sameCheckGroup(binding.group, rule.group)) : undefined;
  const form = ruleDraft?.value ?? null;
  const formDirty = ruleDraft !== null && ruleFingerprint(ruleDraft.value) !== ruleDraft.baseline;
  const configDirty = configFingerprint(config) !== baseline;
  const dirty = configDirty || formDirty || templateDirty;
  useProtectedDraft(dirty);
  const close = () => {
    if (held) { setHeldCloseNotice(heldVariables); return; }
    if (dirty) setConfirmDiscard('editor'); else onClose();
  };
  const closeRule = () => {
    if (held) { setHeldCloseNotice(heldVariables); return; }
    if (formDirty) setConfirmDiscard('rule'); else if (focus && 'fieldId' in focus) onClose(); else setRuleDraft(null);
  };
  const openRule = (value: PlanningCheckRuleDto) => {
    if (!disabled) setRuleDraft({ value, baseline: ruleFingerprint(value) });
  };
  const parsed = form ? planningCheckRuleSchema.safeParse(form) : null;
  const valid = planningCheckConfigSchema.safeParse(config).success;
  const save = (next: PlanningCheckConfigDto) => {
    if (disabled || templateDirty || !planningCheckConfigSchema.safeParse(next).success || command.hasOtherProtectedCommands()) return;
    command.mutate({ input: { expectedRevision: revision, config: next } }, { onSuccess: onClose });
  };
  const saveRule = () => {
    if (!parsed?.success || managedBy(parsed.data)) return;
    const rule = parsed.data;
    save({ ...config, rules: config.rules.some(item => item.id === rule.id) ? config.rules.map(item => item.id === rule.id ? rule : item) : [...config.rules, rule] });
  };
  const openLinked = (group: GenericHeaderWidgetGroupDto) => {
    if (!templateController || !ownershipKnown || disabled || dirty) return;
    setHandoff({ group, key: (handoff?.key ?? 0) + 1 });
  };
  const closeNotice = heldCloseNotice !== null && heldCloseNotice === heldVariables ? <p role="alert" className="mt-3 shrink-0 rounded-lg border border-line bg-canvas p-3 text-sm text-ink">{t(templateHeld ? templateCommand?.uncertain ? 'planningChecks.templateUncertainCloseHelp' : 'planningChecks.templatePendingCloseHelp' : command.uncertain ? writable ? 'planningChecks.uncertainCloseHelp' : 'planningChecks.uncertainReadOnlyCloseHelp' : 'planningChecks.pendingCloseHelp')}</p> : null;
  const feedback = <><SaveFeedback error={command.error} uncertainError={command.uncertain?.error ?? null} subject="fieldValueSave"/>{command.uncertain ? <Button size="sm" disabled={!writable || command.pendingCommand !== null} onClick={() => command.retryUncertain({ onSuccess: onClose })}>{t('planningChecks.retrySameSave')}</Button> : null}</>;
  return <DialogShell open onOpenChange={open => { if (!open) close(); }} title={t('planningChecks.title')} description={t('planningChecks.editorHelp')} variant="drawer">
    {closeNotice}
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto py-4">
      <label className="flex items-center gap-2 font-medium text-ink"><input type="checkbox" checked={config.enabled} disabled={disabled} onChange={e => setConfig({ ...config, enabled: e.target.checked })}/>{t('planningChecks.enable')}</label>
      {!config.enabled ? <p role="status" className="text-xs text-muted">{t('planningChecks.paused')}</p> : null}
      <p role="note" className="rounded border border-line bg-canvas p-3 text-xs text-ink-soft">{t(focus && 'group' in focus ? 'planningChecks.groupEntryHelp' : 'planningChecks.projectEntryHelp')}</p>
      <p className="text-xs text-muted">{t('planningChecks.homeScope')}</p>
      {!writable ? <p role="status" className="text-xs text-muted">{t('planningChecks.readOnlyDraft')}</p> : null}
      {configDirty ? <p role="status" className="text-xs font-medium text-accent-strong">{t('planningChecks.unsavedProjectChanges')}</p> : null}
      {templateController && !ownershipKnown ? <div role="status" className="space-y-2 text-xs text-muted"><p>{t(catalog?.isError ? 'planningChecks.templateOwnershipUnavailable' : 'planningChecks.templateOwnershipLoading')}</p>{catalog?.isError ? <Button size="sm" variant="ghost" disabled={held || catalog.isFetching} onClick={() => void catalog.refetch()}>{t('planningChecks.retryTemplateOwnership')}</Button> : null}</div> : null}
      {config.rules.length === 0 ? <p className="rounded border border-dashed border-line p-3 text-sm text-muted">{t('planningChecks.noRules')}</p> : null}
      {config.rules.map(rule => {
        const binding = managedBy(rule);
        const template = binding ? templateData?.templates.find(item => item.id === binding.templateId) : undefined;
        const unknownOwner = rule.kind === 'balance' && !ownershipKnown;
        const ruleDisabled = disabled || form !== null || Boolean(binding) || unknownOwner;
        return <div key={rule.id} role="group" aria-label={rule.name} className="flex flex-wrap items-center gap-2 rounded-lg border border-line p-2">
          <input type="checkbox" aria-label={t('planningChecks.toggleRule', { rule: rule.name })} checked={rule.enabled} disabled={ruleDisabled} onChange={e => setConfig({ ...config, rules: config.rules.map(item => item.id === rule.id ? { ...item, enabled: e.target.checked } : item) })}/>
          <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium text-ink">{rule.name}</p><p className="text-xs text-muted">{checkKind(rule.kind)} · {t(rule.kind === 'balance' ? 'planningChecks.groupRuleScope' : 'planningChecks.projectRuleScope')}</p>{binding ? <p className="text-xs text-muted">{t('planningChecks.templateManagedHelp', { name: template?.name ?? t('planningChecks.linkedSummary') })}</p> : unknownOwner ? <p className="text-xs text-muted">{t('planningChecks.templateOwnershipHelp')}</p> : null}</div>
          {binding ? <Button size="sm" variant="ghost" disabled={disabled || form !== null || dirty || !ownershipKnown} onClick={() => openLinked(binding.group)}>{t('planningChecks.editLinkedSummary')}</Button> : unknownOwner ? <Link className="text-xs text-accent-ink underline" to={`/w/${workspaceId}/projects/${projectId}?checks=1`}>{t('planningChecks.openProjectChecks')}</Link> : <><Button size="sm" variant="ghost" disabled={ruleDisabled} onClick={() => openRule(structuredClone(rule))}>{t('planningChecks.edit')}</Button><Button size="sm" variant="ghost" disabled={ruleDisabled} onClick={() => setConfig({ ...config, rules: config.rules.filter(item => item.id !== rule.id) })}>{t('planningChecks.remove')}</Button></>}
        </div>;
      })}
      {configDirty && templateData?.bindings.some(binding => !binding.detached) ? <p className="text-xs text-muted">{t('planningChecks.saveProjectBeforeTemplate')}</p> : null}
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1"><ReportSelect label={t('planningChecks.ruleType')} value={kind} disabled={disabled || config.rules.length >= 50} onChange={value => setKind(value === 'balance' ? 'balance' : value === 'overdue' ? 'overdue' : 'presence')}><option value="presence">{t('planningChecks.kind.presence')}</option><option value="balance">{t('planningChecks.kind.balance')}</option><option value="overdue">{t('planningChecks.kind.overdue')}</option></ReportSelect></div>
        <Button size="sm" variant="ghost" disabled={disabled || form !== null || config.rules.length >= 50 || Boolean(templateController && kind === 'balance' && !ownershipKnown)} onClick={() => openRule(newPlanningRule(kind, focus))}>{t('planningChecks.addRule')}</Button>
      </div>
      {handoff && templateController ? <SummaryTemplateControls key={handoff.key} controller={templateController} group={handoff.group} fields={fields} members={members} checks={config.rules} readWidgets={() => templateData?.bindings.find(binding => !binding.detached && sameCheckGroup(binding.group, handoff.group))?.resolved.widgets ?? null} writable={writable && !configDirty} initialAction="update" onDirtyChange={setTemplateDirty} onSaved={onClose}/> : null}
      {templateCommand?.uncertain ? <Button size="sm" disabled={!writable || templateCommand.pendingCommand !== null} onClick={() => templateCommand.retryUncertain({ onSuccess: onClose })}>{t('planningChecks.retryTemplateSave')}</Button> : null}
      <p className="text-xs text-muted">{t('planningChecks.limits')}</p>
      {!valid ? <p role="alert" className="text-xs text-muted">{t('planningChecks.invalidConfig')}</p> : null}
      {revision !== settings.revision ? <p role="status" className="text-xs text-muted">{t('planningChecks.staleDraft')}</p> : null}
      {feedback}
    </div>
    <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line bg-surface pt-3">
      <Button size="sm" variant="ghost" disabled={held} onClick={close}>{t('planningChecks.close')}</Button>
      <Button size="sm" variant="primary" disabled={disabled || form !== null || !valid || templateDirty || command.hasOtherProtectedCommands()} onClick={() => save(config)}>{t('planningChecks.save')}</Button>
    </div>
    {form ? <DialogShell open title={t(config.rules.some(rule => rule.id === form.id) ? 'planningChecks.editRuleTitle' : 'planningChecks.newRuleTitle')} description={t(form.kind === 'balance' ? 'planningChecks.groupRuleEditHelp' : 'planningChecks.projectRuleEditHelp')} onOpenChange={open => { if (!open) closeRule(); }}>
      {closeNotice}
      <PlanningCheckRuleForm key={form.id} workspaceId={workspaceId} rule={form} onChange={value => setRuleDraft(current => current ? { ...current, value } : null)} valid={(parsed?.success ?? false) && !managedBy(form)} onApply={saveRule} onCancel={closeRule} submitLabel={t('planningChecks.saveRule')} fields={fields} members={members} sections={sections} tags={tags} disabled={disabled}/>
      {managedBy(form) ? <p role="status" className="text-xs text-muted">{t('planningChecks.managedRuleDraftHelp')}</p> : null}
      {feedback}
    </DialogShell> : null}
    {confirmDiscard ? <DialogShell open title={t('planningChecks.discardQuestion')} description={t('planningChecks.discardHelp')} onOpenChange={open => { if (!open) setConfirmDiscard(null); }}>
      <DiscardCheckSettingsActions held={held} onDiscard={() => { if (confirmDiscard === 'rule' && !(focus && 'fieldId' in focus)) { setRuleDraft(null); setConfirmDiscard(null); } else onClose(); }} onKeepEditing={() => setConfirmDiscard(null)}/>
    </DialogShell> : null}
  </DialogShell>;
}
