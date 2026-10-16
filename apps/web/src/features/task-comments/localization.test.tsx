import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type * as I18n from '../../i18n';
import type { LocalizationManager, TranslationCatalog } from '../../i18n/LocalizationManager';
import { alpha, anna, installFakeApi, json } from '../../test/fakeApi';
import { renderFieldUi } from '../fields/test/fixtures';
import { rootPath, task } from '../planning/test/fixtures';
import { TaskDiscussion } from './TaskDiscussion';
import { useTaskCommentsWorkspace } from './useTaskCommentsWorkspace';

const state = vi.hoisted(() => ({ manager: undefined as LocalizationManager | undefined }));
vi.mock('../../i18n', async importOriginal => {
  const actual = await importOriginal<typeof I18n>();
  const modules = import.meta.glob<TranslationCatalog>('../../i18n/locales/en/*.json', { eager: true, import: 'default' });
  const en = Object.fromEntries(Object.entries(modules).map(([path, catalog]) => [path.slice(path.lastIndexOf('/') + 1).replace('.json', ''), catalog]));
  const manager = new actual.LocalizationManager({ en, fr: { comments: { body: 'Commentaire', add: 'Publier', problem: { blank: 'Écrivez un commentaire.' } } } });
  state.manager = manager;
  return { ...actual, localization: manager, t: manager.t, formatDate: manager.formatDate, formatNumber: manager.formatNumber, useTranslation: () => actual.useTranslation(manager) };
});
afterEach(() => state.manager?.setLocale('en'));

it('translates current validation while preserving the exact unsent body without posting', async () => {
  const { calls } = installFakeApi({ [`GET ${rootPath}/tasks/${task.id}/comments`]: () => json(200, { data: [], meta: { requestId: 'qa-locale', nextCursor: null } }) });
  function Example() {
    const controller = useTaskCommentsWorkspace(anna.id, alpha.id);
    return <TaskDiscussion task={task} controller={controller} writable canRetry timezone={alpha.timezone} active onOpenTask={vi.fn()} />;
  }
  const ui = renderFieldUi(<Example />);
  fireEvent.change(screen.getByLabelText('Comment'), { target: { value: ' \n ' } });
  await ui.user.click(screen.getByRole('button', { name: 'Add comment' }));
  expect(screen.getByRole('alert')).toHaveTextContent('Write a comment before posting.');
  act(() => state.manager?.setLocale('fr'));
  expect(screen.getByLabelText('Commentaire')).toHaveValue(' \n ');
  expect(screen.getByRole('alert')).toHaveTextContent('Écrivez un commentaire.');
  expect(calls.filter(call => call.method !== 'GET')).toHaveLength(0);
});
