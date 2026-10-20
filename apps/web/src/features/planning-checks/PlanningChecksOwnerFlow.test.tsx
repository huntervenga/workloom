import { screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlanningCheckConfigDto, PlanningCheckRuleDto, SummaryTemplateCatalogDto } from '@workloom/contracts';
import { protectedDraftsFor } from '../../lib/protectedDrafts';
import { queryKeys } from '../../lib/queryKeys';
import { alpha, alphaMembers, anna, failure, installFakeApi, ok } from '../../test/fakeApi';
import { field, FIELD_ID, OTHER_FIELD_ID, PROJECT_ID, renderFieldUi } from '../fields/test/fixtures';
import { useSummaryTemplateWorkspace } from '../summary-templates/queries';
import { PlanningChecksEditor } from './PlanningChecksEditor';
import { newPlanningRule } from './PlanningCheckRuleForm';
import { config, settings } from './testFixtures';

const group = { kind: 'section' as const, sectionId: null };
const version = 'b'.repeat(64), stamp = '2026-10-20T00:00:00.000Z';
const templateId = '10000000-0000-4000-8000-000000000001', bindingId = '10000000-0000-4000-8000-000000000002';
const path = `/api/v1/workspaces/${alpha.id}/projects/${PROJECT_ID}/planning-checks/settings`;
const templatePath = `/api/v1/workspaces/${alpha.id}/projects/${PROJECT_ID}/summary-templates`;
const reminder = config.rules.find((rule): rule is Extract<PlanningCheckRuleDto, { kind: 'presence' }> => rule.kind === 'presence');
if (!reminder) throw new Error('Synthetic presence fixture expected');
const fact: PlanningCheckRuleDto = { ...reminder, id: '70000000-0000-4000-8000-000000000002', name: 'Fact missing', fieldId: OTHER_FIELD_ID, requireBeforeDone: true };
const overdue = { ...newPlanningRule('overdue'), name: 'Unrelated deadline' };
const balanceBase = newPlanningRule('balance', { group });
if (balanceBase.kind !== 'balance') throw new Error('Synthetic balance fixture expected');
const balance = { ...balanceBase, name: 'Delivery budget', sumFieldId: FIELD_ID, target: { kind: 'fixed' as const, unit: 'minutes' as const, value: 2400 } };
const initial: PlanningCheckConfigDto = { enabled: true, rules: [reminder, fact, overdue, balance] };
const { group: ignoredGroup, ...portable } = balance;
void ignoredGroup;
const content = { widgets: [], balanceChecks: [portable], taskScope: 'group' as const, period: { kind: 'project_dates' as const } };
const emptyCatalog: SummaryTemplateCatalogDto = { templates: [], bindings: [], aggregateRevision: 2, checksRevision: 2, sourceVersion: version };
const linkedCatalog: SummaryTemplateCatalogDto = { ...emptyCatalog, templates: [{ id: templateId, workspaceId: alpha.id, projectId: PROJECT_ID, name: 'Delivery template', revision: 1, content, createdAt: stamp, updatedAt: stamp }], bindings: [{ id: bindingId, workspaceId: alpha.id, projectId: PROJECT_ID, group, templateId, revision: 1, templateRevision: 1, person: null, overrides: {}, ruleIds: { [balance.id]: balance.id }, resolved: { widgets: [], balanceChecks: [balance] }, detached: false }] };
afterEach(() => vi.unstubAllGlobals());
function setup(options: { writable?: boolean; linked?: boolean; catalogError?: boolean; noController?: boolean; uncertainTemplate?: boolean; uncertainSettings?: boolean; config?: PlanningCheckConfigDto } = {}) {
  let templateAttempts = 0, settingsAttempts = 0;
  const catalog = options.linked ? linkedCatalog : emptyCatalog;
  const api = installFakeApi({
    [`GET ${templatePath}`]: () => options.catalogError ? failure(503, 'UNAVAILABLE', 'Synthetic catalog failure') : ok(catalog),
    [`PUT ${path}`]: request => ++settingsAttempts === 1 && options.uncertainSettings ? failure(503, 'UNAVAILABLE', 'Synthetic held settings') : ok({ ...settings, revision: 3, config: (request.body as { config: PlanningCheckConfigDto }).config }),
    [`PATCH ${templatePath}/${templateId}`]: () => ++templateAttempts === 1 && options.uncertainTemplate ? failure(503, 'UNAVAILABLE', 'Synthetic held result') : ok(catalog),
  });
  const onClose = vi.fn();
  function Example() {
    const controller = useSummaryTemplateWorkspace(anna.id, alpha.id, PROJECT_ID, true);
    return <PlanningChecksEditor writable={options.writable ?? true} actorId={anna.id} workspaceId={alpha.id} projectId={PROJECT_ID} settings={{ ...settings, config: options.config ?? initial }} fields={[field('Allowance', 'duration'), field('Recorded effort', 'duration', OTHER_FIELD_ID)]} members={alphaMembers} sections={[]} tags={[]} focus={{ group }} onClose={onClose} {...(options.noController ? {} : { templateController: controller })}/>;
  }
  const ui = renderFieldUi(<MemoryRouter><Example/></MemoryRouter>);
  ui.client.setQueryData(queryKeys.me, { actor: anna });
  return { ...ui, api, onClose };
}
async function choose(user: ReturnType<typeof setup>['user'], label: string, option: string) {
  await user.click(screen.getByRole('combobox', { name: label }));
  await user.click(screen.getByRole('option', { name: option }));
}
async function ready() {
  await waitFor(() => expect(within(screen.getByRole('group', { name: balance.name })).getByRole('button', { name: 'Edit' })).toBeEnabled());
}
describe('project rules from a section', () => {
  it('opens a clean list with editable project reminders rather than an eager unfinished load form', async () => {
    const ui = setup(); await ready();
    expect(screen.queryByRole('dialog', { name: 'New check' })).not.toBeInTheDocument();
    for (const rule of [reminder, fact]) {
      const row = within(screen.getByRole('group', { name: rule.name }));
      expect(row.getByText(/Project-wide/)).toBeVisible();
      expect(row.getByRole('button', { name: 'Edit' })).toBeEnabled();
      expect(row.getByRole('button', { name: 'Remove' })).toBeEnabled();
    }
    expect(protectedDraftsFor(ui.client).protecting).toBe(false);
    await ui.user.keyboard('{Escape}');
    expect(ui.onClose).toHaveBeenCalledOnce();
    expect(ui.api.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  });
  it('saves an edited project-wide reminder once, including the current master draft and every other rule', async () => {
    const ui = setup({ linked: true }); await waitFor(() => expect(screen.getByRole('button', { name: 'Edit linked summary' })).toBeEnabled());
    await ui.user.click(screen.getByRole('checkbox', { name: 'Enable planning checks' }));
    await ui.user.click(within(screen.getByRole('group', { name: fact.name })).getByRole('button', { name: 'Edit' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit check' });
    expect(dialog).toHaveAccessibleDescription(/applies across the project/);
    await ui.user.type(within(dialog).getByLabelText('Check name'), ' updated');
    await ui.user.click(within(dialog).getByRole('button', { name: 'Save check' }));
    await waitFor(() => expect(ui.onClose).toHaveBeenCalledOnce());
    const writes = ui.api.calls.filter(call => call.method === 'PUT');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.body).toEqual({ expectedRevision: 2, config: { ...initial, enabled: false, rules: initial.rules.map(rule => rule.id === fact.id ? { ...rule, name: `${fact.name} updated` } : rule) } });
  });
  it('removes a project-wide rule through a visible full-project draft without losing other groups or rules', async () => {
    const ui = setup(); await ready();
    await ui.user.click(within(screen.getByRole('group', { name: reminder.name })).getByRole('button', { name: 'Remove' }));
    expect(screen.queryByRole('group', { name: reminder.name })).not.toBeInTheDocument();
    expect(screen.getByText('Project changes are not saved yet. Save checks to apply them across the project.')).toBeVisible();
    expect(ui.api.calls.filter(call => call.method === 'PUT')).toHaveLength(0);
    await ui.user.click(screen.getByRole('button', { name: 'Save checks' }));
    await waitFor(() => expect(ui.onClose).toHaveBeenCalledOnce());
    expect(ui.api.calls.find(call => call.method === 'PUT')?.body).toEqual({ expectedRevision: 2, config: { ...initial, rules: initial.rules.filter(rule => rule.id !== reminder.id) } });
  });
  it('discards only the nested rule draft while preserving unsaved project changes', async () => {
    const ui = setup(); await ready();
    await ui.user.click(screen.getByRole('checkbox', { name: 'Enable planning checks' }));
    await ui.user.click(within(screen.getByRole('group', { name: reminder.name })).getByRole('button', { name: 'Edit' }));
    await ui.user.type(screen.getByLabelText('Check name'), ' unsaved');
    await ui.user.keyboard('{Escape}');
    await ui.user.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(screen.queryByRole('dialog', { name: 'Edit check' })).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Enable planning checks' })).not.toBeChecked();
    expect(protectedDraftsFor(ui.client).protecting).toBe(true);
    await ui.user.click(screen.getByRole('button', { name: 'Save checks' }));
    await waitFor(() => expect(ui.onClose).toHaveBeenCalledOnce());
    expect(ui.api.calls.find(call => call.method === 'PUT')?.body).toEqual({ expectedRevision: 2, config: { ...initial, enabled: false } });
  });
  it('retains the one-step rule save through an unknown result and retries the original body and key', async () => {
    const ui = setup({ uncertainSettings: true }); await ready();
    await ui.user.click(within(screen.getByRole('group', { name: fact.name })).getByRole('button', { name: 'Edit' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit check' });
    await ui.user.type(within(dialog).getByLabelText('Check name'), ' held');
    await ui.user.click(within(dialog).getByRole('button', { name: 'Save check' }));
    const retry = await within(dialog).findByRole('button', { name: 'Retry the same save' });
    await ui.user.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(within(dialog).getByText('The last save has not been confirmed. Retry the same save before closing so your changes are not lost or saved twice.')).toHaveAttribute('role', 'alert');
    expect(ui.onClose).not.toHaveBeenCalled();
    expect(within(dialog).getByLabelText('Check name')).toBeDisabled();
    await ui.user.click(retry);
    await waitFor(() => expect(ui.onClose).toHaveBeenCalledOnce());
    const writes = ui.api.calls.filter(call => call.method === 'PUT');
    expect(writes).toHaveLength(2);
    expect(writes[1]?.body).toEqual(writes[0]?.body);
    expect(writes[1]?.headers.get('Idempotency-Key')).toBe(writes[0]?.headers.get('Idempotency-Key'));
  });
  it('keeps viewer controls read-only and leaves an untouched section without a false prompt', async () => {
    const ui = setup({ writable: false });
    expect(within(screen.getByRole('group', { name: fact.name })).getByRole('button', { name: 'Edit' })).toBeDisabled();
    expect(within(screen.getByRole('group', { name: fact.name })).getByRole('button', { name: 'Remove' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Enable planning checks' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save checks' })).toBeDisabled();
    await ui.user.keyboard('{Escape}');
    expect(ui.onClose).toHaveBeenCalledOnce();
    expect(ui.api.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  });
  it('retains editable global reminders when ownership lookup fails and safely explains group rules', async () => {
    const ui = setup({ catalogError: true });
    await screen.findByRole('button', { name: 'Reload linked summaries' });
    expect(within(screen.getByRole('group', { name: fact.name })).getByRole('button', { name: 'Edit' })).toBeEnabled();
    const row = within(screen.getByRole('group', { name: balance.name }));
    expect(row.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(row.getByRole('link', { name: 'Open project checks' })).toHaveAttribute('href', `/w/${alpha.id}/projects/${PROJECT_ID}?checks=1`);
    expect(ui.api.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  });
  it('does not assume template ownership when a legacy caller has no controller', async () => {
    const ui = setup({ noController: true });
    const row = within(screen.getByRole('group', { name: balance.name }));
    expect(row.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(row.getByRole('link', { name: 'Open project checks' })).toBeVisible();
    expect(within(screen.getByRole('group', { name: reminder.name })).getByRole('button', { name: 'Edit' })).toBeEnabled();
    expect(ui.api.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  });
});
describe('planning-load setup', () => {
  it('reveals configurable warning bands only after an ordinary field and complete comparison target are selected', async () => {
    const ui = setup({ config: { enabled: true, rules: [] } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add rule' })).toBeEnabled());
    await ui.user.click(screen.getByRole('button', { name: 'Add rule' }));
    expect(screen.getByRole('dialog', { name: 'New check' })).toBeVisible();
    expect(screen.queryByText('Warning bands & colors')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save check' })).toBeDisabled();
    await ui.user.type(screen.getByLabelText('Check name'), 'Custom delivery total');
    await choose(ui.user, 'Values to total', 'Ordinary task values');
    await choose(ui.user, 'Sum this field', 'Allowance');
    expect(screen.queryByText('Warning bands & colors')).not.toBeInTheDocument();
    await choose(ui.user, 'Compare with', 'A person’s working capacity');
    expect(screen.queryByText('Warning bands & colors')).not.toBeInTheDocument();
    await choose(ui.user, 'Capacity belongs to', anna.displayName);
    expect(screen.getByText('Warning bands & colors')).toBeVisible();
    await ui.user.click(screen.getByText('Warning bands & colors'));
    expect(screen.getByRole('checkbox', { name: 'Highlight when the total is below the target' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Highlight when the total is above the target' })).toBeChecked();
    await ui.user.click(screen.getByRole('button', { name: 'Save check' }));
    await waitFor(() => expect(ui.onClose).toHaveBeenCalledOnce());
    expect(ui.api.calls.find(call => call.method === 'PUT')?.body).toMatchObject({ expectedRevision: 2, config: { enabled: true, rules: [{ sumFieldId: FIELD_ID, target: { kind: 'capacity', membershipId: alphaMembers[0]?.id, range: { kind: 'project_dates' }, basis: 'computed' }, under: balance.under, over: balance.over }] } });
  });
  it('preserves the saved target and configurable thresholds when an ordinary load rule is edited', async () => {
    const ui = setup(); await ready();
    await ui.user.click(within(screen.getByRole('group', { name: balance.name })).getByRole('button', { name: 'Edit' }));
    expect(screen.getByText('Warning bands & colors')).toBeVisible();
    expect(screen.getByLabelText('Planning target (hours)')).toHaveValue('40:00');
    await ui.user.type(screen.getByLabelText('Check name'), ' revised');
    await ui.user.click(screen.getByRole('button', { name: 'Save check' }));
    await waitFor(() => expect(ui.onClose).toHaveBeenCalledOnce());
    expect(ui.api.calls.find(call => call.method === 'PUT')?.body).toEqual({ expectedRevision: 2, config: { ...initial, rules: initial.rules.map(rule => rule.id === balance.id ? { ...rule, name: `${balance.name} revised` } : rule) } });
  });
});
describe('linked-summary ownership', () => {
  it('hands managed group checks to the page-owned template editor instead of a project delete', async () => {
    const ui = setup({ linked: true });
    const row = within(screen.getByRole('group', { name: balance.name }));
    await waitFor(() => expect(row.getByRole('button', { name: 'Edit linked summary' })).toBeEnabled());
    expect(row.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(row.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
    expect(row.getByText(/Managed by “Delivery template”/)).toBeVisible();
    await ui.user.click(row.getByRole('button', { name: 'Edit linked summary' }));
    const editor = await screen.findByRole('dialog', { name: 'Edit template for all' });
    await ui.user.type(within(editor).getByLabelText('Template name'), ' updated');
    await ui.user.click(within(editor).getByRole('button', { name: 'Save template for all linked groups' }));
    await waitFor(() => expect(ui.onClose).toHaveBeenCalledOnce());
    expect(ui.api.calls.filter(call => call.method === 'PUT')).toHaveLength(0);
    const writes = ui.api.calls.filter(call => call.method === 'PATCH');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.body).toEqual({ expectedSourceVersion: version, expectedRevision: 1, name: 'Delivery template updated', content });
  });
  it('keeps a dirty or uncertain template handoff visible and retries the original command exactly', async () => {
    const ui = setup({ linked: true, uncertainTemplate: true });
    const row = within(screen.getByRole('group', { name: balance.name }));
    await waitFor(() => expect(row.getByRole('button', { name: 'Edit linked summary' })).toBeEnabled());
    await ui.user.click(row.getByRole('button', { name: 'Edit linked summary' }));
    const editor = await screen.findByRole('dialog', { name: 'Edit template for all' });
    await ui.user.type(within(editor).getByLabelText('Template name'), ' uncertain');
    await ui.user.keyboard('{Escape}');
    expect(within(editor).getByRole('button', { name: 'Keep editing template' })).toBeVisible();
    expect(ui.onClose).not.toHaveBeenCalled();
    await ui.user.click(within(editor).getByRole('button', { name: 'Keep editing template' }));
    await ui.user.click(within(editor).getByRole('button', { name: 'Save template for all linked groups' }));
    const retry = await within(editor).findByRole('button', { name: 'Retry the original template command' });
    await ui.user.keyboard('{Escape}');
    expect(editor).toBeVisible(); expect(retry).toBeEnabled();
    await ui.user.click(retry);
    await waitFor(() => expect(ui.onClose).toHaveBeenCalledOnce());
    const writes = ui.api.calls.filter(call => call.method === 'PATCH');
    expect(writes).toHaveLength(2);
    expect(writes[1]?.body).toEqual(writes[0]?.body);
    expect(writes[1]?.headers.get('Idempotency-Key')).toBe(writes[0]?.headers.get('Idempotency-Key'));
    expect(ui.api.calls.filter(call => call.method === 'PUT')).toHaveLength(0);
  });
});
