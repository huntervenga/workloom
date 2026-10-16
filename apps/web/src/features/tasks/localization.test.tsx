import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as I18n from '../../i18n';
import type { LocalizationManager, TranslationCatalog } from '../../i18n/LocalizationManager';
import GraphCanvas from '../dependencies/GraphCanvas';
import { FieldDefinitionForm } from '../fields/FieldDefinitionForm';
import { alpha, anna, installFakeApi, ok } from '../../test/fakeApi';
import { columns, field, PROJECT_ID, renderFieldUi } from '../fields/test/fixtures';
import { PersonalColumnsDialog } from '../task-table/PersonalColumnsDialog';
import { usePersonalTablePreference } from '../task-table/usePersonalTablePreference';
import { TaskTable } from '../task-table/TaskTable';
import { makeTask, statuses } from '../task-table/taskTableFixtures';
import { TaskCompletionAction } from './TaskCompletionAction';
import { TaskCompletionFeedback } from './TaskCompletionFeedback';
import { useTaskCompletion } from './useTaskCompletion';
import { useTaskCommands } from './useTaskCommands';
import { task as completionTask, rootPath as completionRoot } from '../planning/test/fixtures';
import { failure } from '../../test/fakeApi';
import { TaskFields } from './TaskFields';
import { InlineTaskEdit } from './InlineTaskEdit';
import { buildCreateInput, emptyDraft, type TaskDraftErrors } from './taskDraft';

const state = vi.hoisted(() => ({ manager: undefined as LocalizationManager | undefined }));
vi.mock('../../i18n', async importOriginal => {
  const actual = await importOriginal<typeof I18n>();
  const resources = import.meta.glob<TranslationCatalog>('../../i18n/locales/en/*.json', { eager: true, import: 'default' });
  const en = Object.fromEntries(Object.entries(resources).map(([path, catalog]) => [path.slice(path.lastIndexOf('/') + 1).replace('.json', ''), catalog]));
  const manager = new actual.LocalizationManager({ en, fr: {
    tasks: { completion: { resume: 'Reprendre {{title}}', reviewChange: 'Vérifier le changement de {{title}}.', feedback: 'Changement de statut' }, taskFields: { taskName: 'Nom de tâche', teamEstimateHours: 'Budget équipe, heures' }, taskDraft: { enterATaskName: 'Saisissez un nom de tâche.' } },
    fields: { fieldDefinitionForm: { columnName: 'Nom de colonne', enterAColumnName: 'Saisissez un nom de colonne.' } },
    taskTable: { personalColumns: { title: 'Mes colonnes', columnsDraft: 'Colonnes · brouillon', save: 'Enregistrer les colonnes' }, taskTable: { task2: 'Tâche', teamEstimate: 'Budget équipe' }, estimate: { enterHoursSuchAs15Or1: 'Heures QA invalides.' } },
    dependencies: { graphCanvas: { hasUnfinishedPredecessors: 'Prédécesseurs inachevés', theNextTaskStartsAfterThePreviousTask: 'La tâche suivante attend la précédente' } },
  } });
  state.manager = manager;
  return { ...actual, localization: manager, t: manager.t, formatDate: manager.formatDate, formatNumber: manager.formatNumber, useTranslation: () => actual.useTranslation(manager) };
});
vi.mock('@xyflow/react', () => ({
  Position: { Left: 'left', Right: 'right' }, MarkerType: { ArrowClosed: 'arrowclosed' }, Background: () => null, Controls: () => null,
  ReactFlow: ({ nodes, edges, children }: { nodes: { id: string; ariaLabel: string; data: { label: ReactNode } }[]; edges: { id: string; ariaLabel: string }[]; children: ReactNode }) => <div>{nodes.map(node => <div key={node.id} aria-label={node.ariaLabel}>{node.data.label}</div>)}{edges.map(edge => <span key={edge.id} data-testid="edge-label">{edge.ariaLabel}</span>)}{children}</div>,
}));
afterEach(() => state.manager?.setLocale('en'));

function switchLocale(locale: string) { act(() => state.manager?.setLocale(locale)); }

describe('owned UI live locale feedback', () => {
  it('translates existing task errors while keeping unsaved values and the original validation state', async () => {
    const user = userEvent.setup();
    const draft = { ...emptyDraft('status-todo', null), description: 'Unsaved description', priority: 'high' as const, estimate: 'invalid' };
    function Example() {
      const [errors, setErrors] = useState<TaskDraftErrors>({});
      return <form onSubmit={event => { event.preventDefault(); const result = buildCreateInput('project', draft, { parentTaskId: null, workScope: 'detail' }); if (!result.ok) setErrors(result.errors); }}>
        <TaskFields draft={draft} onChange={() => undefined} errors={errors} statuses={statuses} sections={[]} members={[]} tags={new Map()} savedTagIds={[]} unavailableParticipantIds={[]} estimateMode={{ kind: 'own' }} />
        <button type="submit">Validate QA task</button>
      </form>;
    }
    render(<Example />);
    await user.click(screen.getByRole('button', { name: 'Validate QA task' }));
    expect(screen.getByText('Enter a task name.')).toBeVisible();
    expect(screen.getByText('Enter hours, such as 1.5 or 1:30.')).toBeVisible();
    switchLocale('fr');
    expect(screen.getByLabelText('Nom de tâche')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Saisissez un nom de tâche.')).toBeVisible();
    expect(screen.getByText('Heures QA invalides.')).toBeVisible();
    expect(screen.getByLabelText('Budget équipe, heures')).toHaveValue('invalid');
    expect(screen.getByLabelText('Description')).toHaveValue('Unsaved description');
    expect(screen.getByRole('combobox', { name: 'Priority' })).toHaveTextContent('High');
    switchLocale('en');
    expect(screen.getByText('Enter hours, such as 1.5 or 1:30.')).toBeVisible();
  });

  it('translates a stored field validation issue without clearing its unsaved option or submitting', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<FieldDefinitionForm mode="create" initial={{ name: '', type: 'single_select', historyEnabled: true, locked: false, options: [] }} submitLabel="Save QA column" pending={false} uncertain={false} onRetry={vi.fn()} feedback={null} onSubmit={onSubmit} onCancel={vi.fn()} />);
    await user.type(screen.getByLabelText('New option'), 'Stored option');
    await user.click(screen.getByRole('button', { name: 'Save QA column' }));
    expect(screen.getByText('Enter a column name.')).toBeVisible();
    switchLocale('fr');
    expect(screen.getByLabelText('Nom de colonne')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Saisissez un nom de colonne.')).toBeVisible();
    expect(screen.getByLabelText('New option')).toHaveValue('Stored option');
    expect(screen.getByLabelText('Field type')).toHaveValue('single_select');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('updates table labels and memoized graph labels while keeping stored content and graph input stable', () => {
    const task = makeTask({ id: 'locale-task', title: 'Stored task title' });
    const graphTasks = [{ id: 'a', title: 'Stored graph title', projectName: 'Stored project', statusName: 'Stored status', blocked: true, unresolvedCount: 1, archived: false }];
    const graphEdges = [{ id: 'edge-a', source: 'a', target: 'b' }];
    const graphPositions = { a: { x: 10, y: 20 } };
    render(<><TaskTable tasks={[task]} sections={[]} statuses={statuses} members={[]} onOpenTask={vi.fn()} onCreateTask={vi.fn()} onCreateChild={vi.fn()} columnPreset="compact" /><GraphCanvas tasks={graphTasks} edges={graphEdges} positions={graphPositions} movable={false} connectable={false} onMove={vi.fn()} onConnect={vi.fn()} onOpen={vi.fn()} onViewBlockers={vi.fn()} /></>);
    expect(screen.getByRole('columnheader', { name: 'Task' })).toBeInTheDocument();
    expect(screen.getByTestId('edge-label')).toHaveTextContent('The next task starts after the previous task finishes');
    switchLocale('fr');
    expect(screen.getByRole('columnheader', { name: 'Tâche' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Budget équipe' })).toBeInTheDocument();
    expect(screen.getByText('Prédécesseurs inachevés')).toBeVisible();
    expect(screen.getByTestId('edge-label')).toHaveTextContent('La tâche suivante attend la précédente');
    expect(screen.getByRole('button', { name: 'Stored task title' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stored graph title' })).toBeInTheDocument();
    expect(graphPositions).toEqual({ a: { x: 10, y: 20 } });
  });
});

it('keeps an unsaved personal column choice when the current locale changes', async () => {
  const membershipId = 'c0000000-0000-4000-8000-000000000001';
  const note = field('Stored column name');
  installFakeApi({ [`GET /api/v1/workspaces/${alpha.id}/projects/${PROJECT_ID}/table-preferences/me`]: () => ok({ workspaceId: alpha.id, projectId: PROJECT_ID, membershipId, revision: 0, columns: null }) });
  function Example() {
    const controller = usePersonalTablePreference(anna.id, alpha.id, PROJECT_ID, membershipId);
    return <PersonalColumnsDialog controller={controller} fields={[note]} projectColumns={columns([note])} timeAvailable={false} catalogError={null} onReloadCatalog={async () => undefined} />;
  }
  const ui = renderFieldUi(<Example />);
  await ui.user.click(screen.getByRole('button', { name: 'Columns' }));
  await screen.findByRole('checkbox', { name: 'Tags' });
  await ui.user.click(screen.getByRole('checkbox', { name: 'Tags' }));
  switchLocale('fr');
  expect(screen.getByRole('dialog', { name: 'Mes colonnes' })).toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: 'Tags' })).not.toBeChecked();
  expect(screen.getByRole('button', { name: 'Enregistrer les colonnes' })).toBeEnabled();
  expect(screen.getByRole('checkbox', { name: 'Stored column name' })).toBeChecked();
});

it('translates a retained completion failure and draft action without another write', async () => {
  const completionStatuses = [{ id: completionTask.statusId, workspaceId: completionTask.workspaceId, projectId: completionTask.projectId, name: 'Stored active', group: 'todo' as const, position: 0, revision: 1 }, { id: 'f6000000-0000-4000-8000-000000000002', workspaceId: completionTask.workspaceId, projectId: completionTask.projectId, name: 'Stored done', group: 'done' as const, position: 1, revision: 1 }];
  const { calls } = installFakeApi({ [`PATCH ${completionRoot}/tasks/${completionTask.id}`]: () => failure(422, 'DEPENDENCY_BLOCKED', 'private details') });
  function Example() {
    const commands = useTaskCommands(anna.id, alpha.id); const c = useTaskCompletion(commands, { tasks: [completionTask], statuses: completionStatuses, writable: true, editingTaskId: null }, () => undefined);
    return <><TaskCompletionAction task={completionTask} statuses={completionStatuses} writable blocked={false} pending={c.pending} hasDraft={commands.editSessions.current.has(completionTask.id)} editing={false} onChoose={c.choose} onReview={() => undefined} /><TaskCompletionFeedback controller={c} onReview={() => undefined} /></>;
  }
  const ui = renderFieldUi(<Example />); await ui.user.click(screen.getByRole('button', { name: `Mark ${completionTask.title} complete` }));
  await screen.findByText(`Review the status change for ${completionTask.title}.`);
  switchLocale('fr'); expect(screen.getByText(`Vérifier le changement de ${completionTask.title}.`)).toBeVisible();
  expect(screen.getByRole('button', { name: `Reprendre ${completionTask.title}` })).toBeInTheDocument(); expect(screen.getByRole('alert')).toBeVisible();
  switchLocale('en'); expect(screen.getByRole('button', { name: `Resume draft for ${completionTask.title}` })).toBeInTheDocument(); expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(1);
});


it('translates an existing inline title error without resetting the draft or submitting', async () => {
  const { calls } = installFakeApi({});
  function Example() {
    const commands = useTaskCommands(anna.id, alpha.id);
    return <InlineTaskEdit task={completionTask} field="title" statuses={[]} members={[]} commands={commands} writable onClose={() => undefined} onMoreDetails={() => undefined} onSaved={() => undefined} />;
  }
  const ui = renderFieldUi(<Example />);
  fireEvent.change(screen.getByLabelText('Task name'), { target: { value: '' } });
  await ui.user.keyboard('{Enter}');
  expect(screen.getByText('Enter a task name.')).toBeVisible();
  switchLocale('fr'); expect(screen.getByLabelText('Nom de tâche')).toHaveValue(''); expect(screen.getByLabelText('Nom de tâche')).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByText('Saisissez un nom de tâche.')).toBeVisible();
  switchLocale('en'); expect(screen.getByText('Enter a task name.')).toBeVisible(); expect(calls).toHaveLength(0);
});
