import { useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@workloom/ui';
import { planningCheckConfigSchema, planningCheckRuleSchema, type MembershipDto, type PlanningCheckConfigDto, type PlanningCheckRuleDto, type PlanningCheckSettingsDto, type SectionDto, type TagDto, type TaskFieldDefinitionDto } from '@workloom/contracts';
import { useTranslation } from '../../i18n';
import { DialogShell } from '../../shared/DialogShell';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { canonicalJson } from '../../lib/idempotency';
import { useProtectedDraft } from '../../lib/protectedDrafts';
import { usePlanningCheckCommands } from './queries';
import { checkKind, sameCheckGroup } from './presentation';
import { newPlanningRule, PlanningCheckRuleForm, type CheckFocus } from './PlanningCheckRuleForm';
import { ReportSelect } from '../generic-reports/ReportConfigEditor';

// Filters are sets. Selecting and then unselecting an option must restore a clean draft,
// even when those selections were made in a different order from the stored config.
function ruleFingerprint(rule: PlanningCheckRuleDto): string {
  return canonicalJson({ ...rule, ...(rule.kind === 'presence' ? { requireBeforeDone: 'requireBeforeDone' in rule && rule.requireBeforeDone === true } : {}), filters: { ...rule.filters, statusGroups: [...rule.filters.statusGroups].sort(), tagIds: [...rule.filters.tagIds].sort() } });
}
function configFingerprint(config: PlanningCheckConfigDto): string {
  return canonicalJson({ enabled: config.enabled, rules: config.rules.map(ruleFingerprint) });
}
function initialRule(settings: PlanningCheckSettingsDto, focus?: CheckFocus): PlanningCheckRuleDto | null {
  if (!focus) return null;
  const existing = settings.config.rules.find(rule => 'fieldId' in focus
    ? rule.kind === 'presence' && rule.fieldId === focus.fieldId
    : rule.kind === 'balance' && sameCheckGroup(rule.group, focus.group));
  return existing ? structuredClone(existing) : newPlanningRule('fieldId' in focus ? 'presence' : 'balance', focus);
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

export function PlanningChecksEditor({ actorId, workspaceId, projectId, settings, fields, members, sections, tags, focus, onClose, writable }: {
  writable: boolean; actorId: string; workspaceId: string; projectId: string;
  settings: PlanningCheckSettingsDto; fields: readonly TaskFieldDefinitionDto[];
  members: readonly MembershipDto[]; sections: readonly SectionDto[]; tags: readonly TagDto[];
  focus?: CheckFocus; onClose: () => void;
}) {
  const { t } = useTranslation();
  const [revision] = useState(settings.revision);
  const [baseline] = useState(() => configFingerprint(settings.config));
  const [config, setConfig] = useState<PlanningCheckConfigDto>(() => structuredClone(settings.config));
  const [ruleDraft, setRuleDraft] = useState(() => {
    const value = initialRule(settings, focus);
    return value ? { value, baseline: ruleFingerprint(value) } : null;
  });
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [heldCloseNotice, setHeldCloseNotice] = useState<unknown>(null);
  const [kind, setKind] = useState<PlanningCheckRuleDto['kind']>('presence');
  const commands = usePlanningCheckCommands(actorId, workspaceId, projectId), command = commands.settings;
  const held = command.pendingCommand !== null || command.uncertain !== null;
  const disabled = held || !writable;
  const form = ruleDraft?.value ?? null;
  const dirty = configFingerprint(config) !== baseline || (ruleDraft !== null && ruleFingerprint(ruleDraft.value) !== ruleDraft.baseline);
  useProtectedDraft(dirty);
  const close = () => {
    if (held) { setHeldCloseNotice(command.pendingCommand?.variables ?? command.uncertain?.variables); return; }
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };
  const openRule = (value: PlanningCheckRuleDto) => setRuleDraft({ value, baseline: ruleFingerprint(value) });
  const parsed = form ? planningCheckRuleSchema.safeParse(form) : null;
  const apply = () => {
    if (!parsed?.success) return;
    const rule = parsed.data;
    setConfig({ ...config, rules: config.rules.some(item => item.id === rule.id) ? config.rules.map(item => item.id === rule.id ? rule : item) : [...config.rules, rule] });
    setRuleDraft(null);
  };
  const valid = planningCheckConfigSchema.safeParse(config).success;
  return <DialogShell open onOpenChange={open => { if (!open) close(); }} title={t('planningChecks.title')} description={t('planningChecks.editorHelp')} variant="drawer">
    {heldCloseNotice !== null && heldCloseNotice === (command.pendingCommand?.variables ?? command.uncertain?.variables) ? <p role="alert" className="mt-3 shrink-0 rounded-lg border border-line bg-canvas p-3 text-sm text-ink">{t(command.uncertain ? writable ? 'planningChecks.uncertainCloseHelp' : 'planningChecks.uncertainReadOnlyCloseHelp' : 'planningChecks.pendingCloseHelp')}</p> : null}
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto py-4">
      <label className="flex items-center gap-2 font-medium text-ink"><input type="checkbox" checked={config.enabled} disabled={disabled} onChange={e => setConfig({ ...config, enabled: e.target.checked })}/>{t('planningChecks.enable')}</label>
      {!config.enabled ? <p role="status" className="text-xs text-muted">{t('planningChecks.paused')}</p> : null}
      <p className="text-xs text-muted">{t('planningChecks.homeScope')}</p>
      {!writable ? <p role="status" className="text-xs text-muted">{t('planningChecks.readOnlyDraft')}</p> : null}
      {config.rules.length === 0 && !form ? <p className="rounded border border-dashed border-line p-3 text-sm text-muted">{t('planningChecks.noRules')}</p> : null}
      {config.rules.map(rule => <div key={rule.id} className="flex items-center gap-2 rounded-lg border border-line p-2">
        <input type="checkbox" aria-label={t('planningChecks.toggleRule', { rule: rule.name })} checked={rule.enabled} disabled={disabled || form !== null} onChange={e => setConfig({ ...config, rules: config.rules.map(item => item.id === rule.id ? { ...item, enabled: e.target.checked } : item) })}/>
        <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium text-ink">{rule.name}</p><p className="text-xs text-muted">{checkKind(rule.kind)}</p></div>
        <Button size="sm" variant="ghost" disabled={disabled || form !== null} onClick={() => openRule(structuredClone(rule))}>{t('planningChecks.edit')}</Button>
        <Button size="sm" variant="ghost" disabled={disabled || form !== null} onClick={() => setConfig({ ...config, rules: config.rules.filter(item => item.id !== rule.id) })}>{t('planningChecks.remove')}</Button>
      </div>)}
      {form ? <PlanningCheckRuleForm workspaceId={workspaceId} rule={form} onChange={value => setRuleDraft(current => current ? { ...current, value } : null)} valid={parsed?.success ?? false} onApply={apply} onCancel={() => setRuleDraft(null)} fields={fields} members={members} sections={sections} tags={tags} disabled={disabled}/> : <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1"><ReportSelect label={t('planningChecks.ruleType')} value={kind} disabled={disabled || config.rules.length >= 50} onChange={value => setKind(value === 'balance' ? 'balance' : value === 'overdue' ? 'overdue' : 'presence')}><option value="presence">{t('planningChecks.kind.presence')}</option><option value="balance">{t('planningChecks.kind.balance')}</option><option value="overdue">{t('planningChecks.kind.overdue')}</option></ReportSelect></div>
        <Button size="sm" variant="ghost" disabled={disabled || config.rules.length >= 50} onClick={() => openRule(newPlanningRule(kind, focus))}>{t('planningChecks.addRule')}</Button>
      </div>}
      <p className="text-xs text-muted">{t('planningChecks.limits')}</p>
      {!valid ? <p role="alert" className="text-xs text-muted">{t('planningChecks.invalidConfig')}</p> : null}
      {revision !== settings.revision ? <p role="status" className="text-xs text-muted">{t('planningChecks.staleDraft')}</p> : null}
      <SaveFeedback error={command.error} uncertainError={command.uncertain?.error ?? null} subject="fieldValueSave"/>
      {command.uncertain ? <Button size="sm" disabled={!writable || command.pendingCommand !== null} onClick={() => command.retryUncertain({ onSuccess: onClose })}>{t('planningChecks.retrySameSave')}</Button> : null}
    </div>
    <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line bg-surface pt-3">
      <Button size="sm" variant="ghost" disabled={held} onClick={close}>{t('planningChecks.close')}</Button>
      <Button size="sm" variant="primary" disabled={disabled || form !== null || !valid || command.hasOtherProtectedCommands()} onClick={() => command.mutate({ input: { expectedRevision: revision, config } }, { onSuccess: onClose })}>{t('planningChecks.save')}</Button>
    </div>
    {confirmDiscard ? <DialogShell open title={t('planningChecks.discardQuestion')} description={t('planningChecks.discardHelp')} onOpenChange={open => { if (!open) setConfirmDiscard(false); }}>
      <DiscardCheckSettingsActions held={held} onDiscard={onClose} onKeepEditing={() => setConfirmDiscard(false)}/>
    </DialogShell> : null}
  </DialogShell>;
}
