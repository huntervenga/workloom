import type { DuplicationPreviewDto, DuplicationResultDto, DuplicateTaskPreviewInput, DuplicateSectionPreviewInput, ProjectDto, SectionDto } from '@workloom/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../lib/queryClient';
import { queryKeys } from '../../lib/queryKeys';
import { alpha, alphaMembers, anna, deferred, failure, installFakeApi, ok, type RouteTable } from '../../test/fakeApi';
import { field, renderFieldUi } from '../fields/test/fixtures';
import { task } from '../planning/test/fixtures';
import { useDuplication } from './useDuplication';
const FACT = '90000000-0000-4000-8000-000000000002', NEW = '90000000-0000-4000-8000-000000000003', SECTION = '90000000-0000-4000-8000-000000000004';
const fields = [{ ...field('Hours Estimation', 'duration'), projectId: task.projectId }, { ...field('Fact', 'duration', FACT), projectId: task.projectId }];
const section: SectionDto = { id: SECTION, workspaceId: alpha.id, projectId: task.projectId, name: 'Source section', position: 0, revision: 1, archivedAt: null };
const project: ProjectDto = { id: task.projectId, workspaceId: alpha.id, name: 'Source project', revision: 1, archivedAt: null, createdAt: task.createdAt, updatedAt: task.updatedAt };
const root = `/api/v1/workspaces/${alpha.id}`, previewPath = `${root}/tasks/${task.id}/duplicate-preview`, writePath = `${root}/tasks/${task.id}/duplicate`, sectionPreview = `${root}/sections/${SECTION}/duplicate-preview`, sectionWrite = `${root}/sections/${SECTION}/duplicate`;
const taskResult: DuplicationResultDto = { kind: 'task', projectId: task.projectId, rootTaskId: NEW, section: null, taskIds: [NEW] };
const sectionResult: DuplicationResultDto = { kind: 'section', projectId: task.projectId, rootTaskId: null, section: { ...section, id: NEW, name: 'Source section (copy)' }, taskIds: [] };
const copy = { description: true, assignee: true, dates: true, tags: true, priority: true, participants: true, subtasks: true, customFieldIds: [] };
const version = (chosen: boolean) => (chosen ? 'b' : 'a').repeat(64);
function preview(input: DuplicateTaskPreviewInput | DuplicateSectionPreviewInput, kind: 'task' | 'section' = 'task'): DuplicationPreviewDto {
  return { kind, sourceId: kind === 'task' ? task.id : SECTION, projectId: task.projectId, sourceVersion: version(input.copy.customFieldIds.includes(FACT)), name: 'title' in input ? input.title : input.name, taskCount: 'includeTasks' in input && !input.includeTasks ? 0 : 1, customValueCount: input.copy.customFieldIds.length, copyableFields: fields, settings: null };
}
function setup(options: { routes?: RouteTable; role?: 'owner' | 'member' | 'viewer' } = {}) {
  const api = installFakeApi({ [`POST ${previewPath}`]: request => ok(preview(request.body as DuplicateTaskPreviewInput)), [`POST ${writePath}`]: () => ok(taskResult), [`POST ${sectionPreview}`]: request => ok(preview(request.body as DuplicateSectionPreviewInput, 'section')), [`POST ${sectionWrite}`]: () => ok(sectionResult), ...options.routes });
  const client = createQueryClient({ retry: false }), onDuplicated = vi.fn();
  client.setQueryData(queryKeys.me, { actor: anna }); client.setQueryData(queryKeys.workspace(anna.id, alpha.id), { ...alpha, role: options.role ?? 'owner' }); client.setQueryData(queryKeys.project(anna.id, alpha.id, task.projectId), project);
  function Harness() { const controller = useDuplication({ actorId: anna.id, workspaceId: alpha.id, projectId: task.projectId, fields, members: alphaMembers, writable: true, onDuplicated }); return <><button onClick={() => controller.openTask(task)}>Open task copy</button><button onClick={() => controller.openSection(section)}>Open section copy</button>{controller.dialog}</>; }
  return { ...renderFieldUi(<Harness />, client), api, onDuplicated };
}
const dialog = () => screen.getByRole('dialog', { name: 'Duplicate task' });
const submit = () => within(dialog()).getByRole('button', { name: 'Duplicate task' });
const writes = (calls: ReturnType<typeof installFakeApi>['calls']) => calls.filter(call => call.path === writePath || call.path === sectionWrite);
async function open(ui: ReturnType<typeof setup>) { await ui.user.click(screen.getByRole('button', { name: 'Open task copy' })); await waitFor(() => expect(submit()).toBeEnabled()); }

describe('ordinary duplication dialog', () => {
  it('shows the number of independent attachment copies', async () => {
    const ui = setup({ routes: { [`POST ${previewPath}`]: request => ok({ ...preview(request.body as DuplicateTaskPreviewInput), attachmentCount: 3 }) } });
    await open(ui);
    expect(screen.getByText('3 attachments will be copied independently')).toBeVisible();
    await ui.user.click(submit());
    await waitFor(() => expect(ui.onDuplicated).toHaveBeenCalledExactlyOnceWith(taskResult));
  });
  it('auto-previews with no custom values selected before one direct duplicate action', async () => {
    const ui = setup(); await open(ui);
    expect(screen.getByRole('checkbox', { name: 'Hours Estimation' })).not.toBeChecked(); expect(screen.getByRole('checkbox', { name: 'Fact' })).not.toBeChecked();
    expect(screen.getByText('Fields start empty unless selected. Copied values, including actual hours, can affect reports.')).toBeVisible();
    expect(ui.api.calls.filter(call => call.path === previewPath)).toHaveLength(1); expect(ui.api.calls[0]?.body).toEqual({ projectId: task.projectId, title: `${task.title} (copy)`, copy });
    await ui.user.click(submit()); await waitFor(() => expect(ui.onDuplicated).toHaveBeenCalledExactlyOnceWith(taskResult));
    expect(writes(ui.api.calls)).toHaveLength(1); expect(writes(ui.api.calls)[0]?.body).toEqual({ projectId: task.projectId, title: `${task.title} (copy)`, copy, expectedSourceVersion: version(false) });
    expect(writes(ui.api.calls)[0]?.headers.get('Idempotency-Key')).toBeTruthy(); expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('lets the user explicitly select ordinary Fact and sends its stable ID with the refreshed source version', async () => {
    const ui = setup(); await open(ui); await ui.user.click(screen.getByRole('checkbox', { name: 'Fact' })); expect(submit()).toBeDisabled();
    await waitFor(() => expect(ui.api.calls.filter(call => call.path === previewPath)).toHaveLength(2)); await waitFor(() => expect(submit()).toBeEnabled());
    expect(screen.getByRole('checkbox', { name: 'Fact' })).toBeChecked(); await ui.user.click(submit()); await waitFor(() => expect(ui.onDuplicated).toHaveBeenCalledOnce());
    expect(writes(ui.api.calls)[0]?.body).toEqual({ projectId: task.projectId, title: `${task.title} (copy)`, copy: { ...copy, customFieldIds: [FACT] }, expectedSourceVersion: version(true) });
  });
  it('locks all inputs while pending and blocks Cancel, header close and Escape without losing the command', async () => {
    const gate = deferred<Response>(), ui = setup({ routes: { [`POST ${writePath}`]: () => gate.promise } }); await open(ui); await ui.user.click(submit()); await waitFor(() => expect(writes(ui.api.calls)).toHaveLength(1));
    expect(screen.getByLabelText('Task name')).toBeDisabled(); for (const checkbox of within(dialog()).getAllByRole('checkbox')) expect(checkbox).toBeDisabled(); expect(within(dialog()).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await ui.user.click(screen.getByLabelText('Close')); await ui.user.keyboard('{Escape}'); expect(screen.getByText('This copy has not been confirmed. Retry the same copy before closing.')).toBeVisible();
    expect(dialog()).toBeVisible(); expect(ui.onDuplicated).not.toHaveBeenCalled(); expect(writes(ui.api.calls)).toHaveLength(1); await act(async () => gate.resolve(ok(taskResult))); await waitFor(() => expect(ui.onDuplicated).toHaveBeenCalledExactlyOnceWith(taskResult));
  });
  it('keeps a503 uncertain and explicitly retries identical request bytes and Idempotency-Key', async () => {
    let attempts = 0; const ui = setup({ routes: { [`POST ${writePath}`]: () => ++attempts === 1 ? failure(503, 'TEMPORARILY_UNAVAILABLE', 'Private server text') : ok(taskResult) } }); await open(ui); await ui.user.click(submit());
    const retry = await screen.findByRole('button', { name: 'Retry the same copy' }); expect(screen.getByLabelText('Task name')).toBeDisabled(); expect(screen.getByRole('checkbox', { name: 'Fact' })).toBeDisabled(); expect(screen.queryByText('Private server text')).not.toBeInTheDocument();
    await ui.user.click(screen.getByLabelText('Close')); expect(dialog()).toBeVisible(); expect(attempts).toBe(1); await ui.user.click(retry); await waitFor(() => expect(ui.onDuplicated).toHaveBeenCalledExactlyOnceWith(taskResult));
    const sent = writes(ui.api.calls); expect(sent).toHaveLength(2); expect(sent[1]?.body).toEqual(sent[0]?.body); expect(sent[1]?.headers.get('Idempotency-Key')).toBe(sent[0]?.headers.get('Idempotency-Key'));
  });
  it('hides an old successful preview after refetch failure and refuses creation from that cached result', async () => {
    let reads = 0; const ui = setup({ routes: { [`POST ${previewPath}`]: request => ++reads === 1 ? ok(preview(request.body as DuplicateTaskPreviewInput)) : failure(500, 'INTERNAL_ERROR', 'Private preview details') } }); await open(ui); expect(screen.getByText('1 task will be created')).toBeVisible();
    await act(async () => { await ui.client.invalidateQueries({ queryKey: [...queryKeys.workspace(anna.id, alpha.id), 'duplication-preview'] }); }); await screen.findByText('The copy could not be checked. Review the options and try again.');
    expect(screen.queryByText('1 task will be created')).not.toBeInTheDocument(); expect(screen.queryByText('Private preview details')).not.toBeInTheDocument(); expect(submit()).toBeDisabled(); await ui.user.click(submit()); expect(writes(ui.api.calls)).toHaveLength(0);
  });
  it('pauses a cached preview as soon as current workspace authorization becomes stale', async () => {
    const ui = setup(); await open(ui); await act(async () => { await ui.client.invalidateQueries({ queryKey: queryKeys.workspace(anna.id, alpha.id), exact: true, refetchType: 'none' }); });
    expect(screen.getByText('Editing is paused while your current access is checked.')).toBeVisible(); expect(screen.getByLabelText('Task name')).toBeDisabled(); expect(submit()).toBeDisabled(); expect(screen.queryByText('1 task will be created')).not.toBeInTheDocument(); await ui.user.click(submit()); expect(writes(ui.api.calls)).toHaveLength(0);
  });
  it('allows member section copying without tasks while manager-only settings stay disabled', async () => {
    const ui = setup({ role: 'member' }); await ui.user.click(screen.getByRole('button', { name: 'Open section copy' })); const sectionDialog = screen.getByRole('dialog', { name: 'Duplicate section' });
    const settings = within(sectionDialog).getByRole('checkbox', { name: 'Copy section summaries and planning checks' }); expect(settings).toBeDisabled(); expect(settings).not.toBeChecked();
    await ui.user.click(within(sectionDialog).getByRole('checkbox', { name: 'Copy tasks' })); await waitFor(() => expect(within(sectionDialog).getByRole('button', { name: 'Duplicate section' })).toBeEnabled()); expect(screen.getByText('0 tasks will be created')).toBeVisible();
    await ui.user.click(within(sectionDialog).getByRole('button', { name: 'Duplicate section' })); await waitFor(() => expect(ui.onDuplicated).toHaveBeenCalledExactlyOnceWith(sectionResult));
    expect(writes(ui.api.calls)[0]?.body).toEqual({ name: 'Source section (copy)', includeTasks: false, includeSettings: false, copy, expectedSourceVersion: version(false) });
  });
  it('requires a fresh preview after a confirmed stale-source rejection, then creates using the new digest', async () => {
    let reads = 0, attempts = 0;
    const ui = setup({ routes: {
      [`POST ${previewPath}`]: request => ok({ ...preview(request.body as DuplicateTaskPreviewInput), sourceVersion: (++reads === 1 ? 'a' : 'c').repeat(64) }),
      [`POST ${writePath}`]: () => ++attempts === 1 ? failure(409, 'PREVIEW_STALE', 'Private stale details') : ok(taskResult),
    } });
    await open(ui); await ui.user.click(submit());
    const refresh = await screen.findByRole('button', { name: 'Refresh preview' });
    expect(submit()).toBeDisabled(); expect(ui.onDuplicated).not.toHaveBeenCalled(); expect(writes(ui.api.calls)).toHaveLength(1);
    expect(screen.queryByText('Private stale details')).not.toBeInTheDocument();
    await ui.user.click(refresh); await waitFor(() => expect(submit()).toBeEnabled());
    await ui.user.click(submit()); await waitFor(() => expect(ui.onDuplicated).toHaveBeenCalledExactlyOnceWith(taskResult));
    expect(writes(ui.api.calls)[1]?.body).toEqual({ projectId: task.projectId, title: `${task.title} (copy)`, copy, expectedSourceVersion: 'c'.repeat(64) });
  });

  it('discloses literal capacity people, dates and manual overrides even when copied summaries have friendly labels', async () => {
    const person = alphaMembers[0]; if (!person) throw new Error('Expected a literal capacity person');
    const range = { kind: 'dates' as const, from: '2026-11-02', to: '2026-11-06' };
    const ui = setup({ routes: { [`POST ${sectionPreview}`]: request => ok({ ...preview(request.body as DuplicateSectionPreviewInput, 'section'), settings: {
      aggregateRevision: 3, checksRevision: 5,
      headerWidgets: [{ group: { kind: 'section', sectionId: SECTION }, widgets: [{ key: 'literalCapacity', kind: 'capacity', label: 'Friendly capacity summary', membershipId: person.id, range, override: { minutes: 1800, note: 'Retain this exact allowance' } }] }],
      balanceChecks: [{ id: '90000000-0000-4000-8000-000000000005', name: 'Friendly capacity check', enabled: true, kind: 'balance', hierarchy: 'all_tasks', filters: { statusGroups: [], tagIds: [], assignee: { kind: 'all' }, dateRange: null }, group: { kind: 'section', sectionId: SECTION }, sumFieldId: fields[0]?.id, cohort: { kind: 'all_tasks' }, missingPlan: 'unknown', target: { kind: 'capacity', membershipId: person.id, range, basis: 'configured_manual', manualMinutes: 2400 }, under: { enabled: false, thresholdBps: 8000, fullIntensityAtBps: 5000, nearColor: '#eab308', farColor: '#dc2626' }, over: { enabled: false, thresholdBps: 11000, fullIntensityAtBps: 15000, nearColor: '#f97316', farColor: '#dc2626' } }],
    } }) } });
    await ui.user.click(screen.getByRole('button', { name: 'Open section copy' }));
    const sectionDialog = screen.getByRole('dialog', { name: 'Duplicate section' });
    await waitFor(() => expect(within(sectionDialog).getByRole('button', { name: 'Duplicate section' })).toBeEnabled());
    const items = within(sectionDialog).getAllByRole('listitem'), summary = items.find(item => item.textContent?.includes('Friendly capacity summary')), check = items.find(item => item.textContent?.includes('Friendly capacity check'));
    expect(summary).toBeDefined(); expect(check).toBeDefined();
    for (const item of [summary, check]) { expect(item).toHaveTextContent(person.displayName); expect(item).toHaveTextContent('2026-11-02'); expect(item).toHaveTextContent('2026-11-06'); }
    expect(summary).toHaveTextContent('Manual override: 1,800 minutes'); expect(summary).toHaveTextContent('Retain this exact allowance');
    expect(check).toHaveTextContent('Hours Estimation'); expect(check).toHaveTextContent('Manual override: 2,400 minutes');
    expect(writes(ui.api.calls)).toHaveLength(0);
  });

});
