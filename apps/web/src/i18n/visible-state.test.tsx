import * as Dialog from '@radix-ui/react-dialog';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectDto } from '@workloom/contracts';
import { localization, t } from './index';
import type * as LocalizationExports from './index';
import { NameForm } from '../shared/NameForm';
import { alpha, alphaMembers, anna, created, installFakeApi, ok, project, renderApp, singleActorRoutes } from '../test/fakeApi';

vi.mock('./index', async importOriginal => {
  const actual = await importOriginal<typeof LocalizationExports>();
  const { catalogsFromModules } = await import('./LocalizationManager');
  const english = import.meta.glob('./locales/en/*.json', { eager: true, import: 'default' });
  const german = import.meta.glob('./__fixtures__/de/*.json', { eager: true, import: 'default' });
  // This fixture's demo namespace only belongs to the isolated manager tests, not the app.
  const catalogs = catalogsFromModules({ ...english, ...Object.fromEntries(Object.entries(german).filter(([path]) => !path.endsWith('/demo.json'))) });
  const manager = new actual.LocalizationManager(catalogs);
  return { ...actual, localization: manager, t: manager.t, useTranslation: () => actual.useTranslation(manager) };
});

afterEach(() => { act(() => localization.setLocale('en')); });

describe('localized visible form and announcement state', () => {
  it('updates an already-visible name validation and keeps the typed draft and focus', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<Dialog.Root open><NameForm label="Project name" initialName="" maxLength={200} validate={name => name.trim() ? null : t('projects.projectDialogs.enterAProjectName')} submitLabel="Create" pending={false} onSubmit={onSubmit} /></Dialog.Root>);
    const input = screen.getByRole('textbox', { name: 'Project name' });
    await user.type(input, '   ');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(screen.getByText('Enter a project name.')).toBeInTheDocument();
    expect(input).toHaveFocus();
    act(() => localization.setLocale('de'));
    expect(screen.getByText('Geben Sie einen Projektnamen ein.')).toBeInTheDocument();
    expect(screen.queryByText('Enter a project name.')).not.toBeInTheDocument();
    expect(screen.getByText('Bis zu 200 Zeichen.')).toBeInTheDocument();
    expect(input).toHaveValue('   ');
    expect(input).toHaveFocus();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('updates a confirmed project announcement without another write or renaming persisted content', async () => {
    let projects: ProjectDto[] = [];
    const path = `/api/v1/workspaces/${alpha.id}/projects`;
    const name = 'Проект клиента';
    const { calls } = installFakeApi({
      ...singleActorRoutes(anna, [alpha], { [alpha.id]: alphaMembers }),
      [`GET ${path}`]: () => ok(projects),
      [`POST ${path}`]: () => {
        const next = project(alpha.id, 'e0000000-0000-4000-8000-000000000071', name);
        projects = [next];
        return created(next);
      },
    });
    const { user } = renderApp(`/w/${alpha.id}/projects`);
    await user.click(await screen.findByRole('button', { name: 'New project' }));
    const dialog = await screen.findByRole('dialog', { name: 'New project' });
    fireEvent.change(within(dialog).getByLabelText('Project name'), { target: { value: name } });
    await user.click(within(dialog).getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveTextContent(`Project “${name}” created.`);
    const writesBefore = calls.filter(call => call.method === 'POST').length;
    act(() => localization.setLocale('de'));
    expect(screen.getByRole('status')).toHaveTextContent(`Projekt „${name}“ erstellt.`);
    expect(within(screen.getByRole('main')).getByRole('link', { name })).toBeInTheDocument();
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(writesBefore);
    expect(projects[0]?.name).toBe(name);
  });
});
