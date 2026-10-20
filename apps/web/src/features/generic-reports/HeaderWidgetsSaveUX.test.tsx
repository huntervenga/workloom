import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { genericHeaderWidgetSchema, type GenericHeaderWidgetDto, type TaskFieldDefinitionDto } from '@workloom/contracts';
import { alpha, alphaMembers } from '../../test/fakeApi';
import { protectedDraftsFor } from '../../lib/protectedDrafts';
import { HeaderWidgets } from './HeaderWidgets';
import { fact, plan } from './test/fixtures';

afterEach(() => vi.restoreAllMocks());
const group = { kind: 'section' as const, sectionId: null };
const retained: GenericHeaderWidgetDto = { key: 'retained', label: 'Our measured result', kind: 'measure', measure: { key: 'original_measure', operation: 'sum', fieldId: fact.id } };
type Save = (widgets: GenericHeaderWidgetDto[], revision: number, done: () => void) => void;
function example(widgets: GenericHeaderWidgetDto[] = [], onSave: Save = (_widgets, _revision, done) => done()) {
 const user = userEvent.setup(), client = new QueryClient(), save = vi.fn(onSave);
 const view = (fields: readonly TaskFieldDefinitionDto[] = [plan, fact]) => <QueryClientProvider client={client}><MemoryRouter><HeaderWidgets group={group} title="Delivery" rules={[{ group, widgets }]} result={undefined} fields={fields} members={alphaMembers} workspaceId={alpha.id} writable disabled={false} loading={false} revision={2} feedback={null} uncertain={false} projectDateRange={{ from: '2026-10-19', to: '2026-10-25' }} onRetry={() => undefined} onSave={save} /></MemoryRouter></QueryClientProvider>;
 const ui = render(view());
 const open = async () => { await user.click(screen.getByRole('button', { name: 'Configure summary for Delivery' })); return screen.getByRole('dialog', { name: 'Summary · Delivery' }); };
 const choose = async (dialog: HTMLElement, label: string, option: string) => { await user.click(within(dialog).getByRole('combobox', { name: label })); await user.click(screen.getByRole('option', { name: option })); };
 return { user, client, save, open, choose, rerenderFields: (fields: readonly TaskFieldDefinitionDto[]) => ui.rerender(view(fields)) };
}

it('saves the current field calculation directly without Add summary', async () => {
 const { user, save, open, choose } = example([retained]), dialog = await open();
 await choose(dialog, 'Field', 'Budget');
 await choose(dialog, 'Calculation', 'Average');
 await user.click(within(dialog).getByRole('button', { name: 'Save summary' }));
 expect(save).toHaveBeenCalledOnce(); const [widgets, revision] = save.mock.calls[0] ?? [];
 expect(revision).toBe(2); expect(widgets).toHaveLength(2); expect(widgets?.[0]).toEqual(retained);
 const added = widgets?.[1]; expect(added).toMatchObject({ kind: 'measure', measure: { operation: 'avg', fieldId: plan.id } });
 expect(added?.key).toMatch(/^w_/); expect(genericHeaderWidgetSchema.parse(added)).toEqual(added);
 expect(screen.queryByRole('dialog', { name: 'Summary · Delivery' })).not.toBeInTheDocument();
});

it('saves the selected person and project dates directly, including a zero manual target', async () => {
 const { user, save, open, choose } = example(), dialog = await open();
 await choose(dialog, 'Summary type', 'Person’s available working time');
 await choose(dialog, 'Person', 'Анна Тестова');
 await user.click(within(dialog).getByRole('checkbox', { name: 'Override available time for this summary' }));
 await user.type(within(dialog).getByLabelText('Manual available minutes'), '0');
 await user.click(within(dialog).getByRole('button', { name: 'Save summary' }));
 expect(save).toHaveBeenCalledOnce(); expect(save.mock.calls[0]?.[0]).toEqual([expect.objectContaining({ kind: 'capacity', membershipId: alphaMembers[0]?.id, range: { kind: 'project_dates' }, override: { minutes: 0 } })]);
});

it('saves an edited summary directly and preserves both its identity and its custom label', async () => {
 const { user, save, open, choose } = example([retained]), dialog = await open();
 await user.click(within(dialog).getByRole('button', { name: 'Edit Our measured result' }));
 await choose(dialog, 'Calculation', 'Maximum');
 expect(within(dialog).getByRole('button', { name: 'Save summary' })).toBeEnabled();
 await user.click(within(dialog).getByRole('button', { name: 'Save summary' }));
 expect(save).toHaveBeenCalledOnce(); expect(save.mock.calls[0]?.[0]).toEqual([{ ...retained, measure: { ...retained.measure, operation: 'max' } }]);
});

it('can prepare another summary, then save the final current editor without adding twice', async () => {
 const { user, save, open, choose } = example(), dialog = await open();
 await choose(dialog, 'Field', 'Budget');
 await user.click(within(dialog).getByRole('button', { name: 'Add another summary' }));
 await choose(dialog, 'Summary type', 'Person’s available working time');
 await choose(dialog, 'Person', 'Анна Тестова');
 await user.click(within(dialog).getByRole('button', { name: 'Save summary' }));
 expect(save).toHaveBeenCalledOnce(); const widgets = save.mock.calls[0]?.[0] ?? [];
 expect(widgets).toHaveLength(2); expect(widgets[0]).toMatchObject({ kind: 'measure', measure: { fieldId: plan.id } }); expect(widgets[1]).toMatchObject({ kind: 'capacity', membershipId: alphaMembers[0]?.id });
 expect(new Set(widgets.map(widget => widget.key)).size).toBe(2);
});

it('shows validation instead of silently discarding an incomplete current editor', async () => {
 const { user, save, open, choose } = example([retained]), dialog = await open();
 await choose(dialog, 'Summary type', 'Person’s available working time');
 await user.click(within(dialog).getByRole('button', { name: 'Save summary' }));
 expect(save).not.toHaveBeenCalled(); expect(within(dialog).getByRole('alert')).toHaveTextContent('Choose a person');
 await choose(dialog, 'Person', 'Анна Тестова');
 await choose(dialog, 'Period', 'Custom range');
 await user.click(within(dialog).getByRole('button', { name: 'Save summary' }));
 expect(save).not.toHaveBeenCalled(); expect(within(dialog).getByRole('alert')).toHaveTextContent(/date|range/i);
 fireEvent.change(within(dialog).getByLabelText('From (inclusive)'), { target: { value: '2026-10-19' } });
 fireEvent.change(within(dialog).getByLabelText('To (inclusive)'), { target: { value: '2026-10-25' } });
 expect(within(dialog).getByLabelText('From (inclusive)')).toHaveValue('2026-10-19');
 expect(within(dialog).getByLabelText('To (inclusive)')).toHaveValue('2026-10-25');
 await user.click(within(dialog).getByRole('button', { name: 'Save summary' }));
 expect(save).toHaveBeenCalledOnce(); expect(save.mock.calls[0]?.[0]).toHaveLength(2);
});

it('saves removals with an untouched blank editor, including clearing the last summary', async () => {
 const { user, save, open } = example([retained]), dialog = await open();
 await user.click(within(dialog).getByRole('button', { name: 'Remove Our measured result' }));
 await user.click(within(dialog).getByRole('button', { name: 'Save summary' }));
 expect(save).toHaveBeenCalledOnce(); expect(save.mock.calls[0]?.[0]).toEqual([]);
});

it('retains the auto-applied summary after a rejected save and reuses the same key on another save', async () => {
 const { user, save, open, choose } = example([], () => undefined), dialog = await open();
 await choose(dialog, 'Field', 'Budget');
 await user.click(within(dialog).getByRole('button', { name: 'Save summary' }));
 expect(save).toHaveBeenCalledOnce(); expect(dialog).toBeVisible(); expect(within(dialog).getByText('Budget · Sum')).toBeVisible();
 await user.click(within(dialog).getByRole('button', { name: 'Save summary' }));
 expect(save).toHaveBeenCalledTimes(2); expect(save.mock.calls[1]?.[0]).toEqual(save.mock.calls[0]?.[0]);
 expect(save.mock.calls[1]?.[0]).toHaveLength(1);
});

it('does not save a now-unavailable selected field or silently drop it', async () => {
 const { user, save, open, choose, rerenderFields } = example([retained]), dialog = await open();
 await choose(dialog, 'Field', 'Budget');
 rerenderFields([{ ...plan, archivedAt: '2026-10-20T10:00:00.000Z' }, fact]);
 await user.click(within(dialog).getByRole('button', { name: 'Save summary' }));
 expect(save).not.toHaveBeenCalled(); expect(within(dialog).getByRole('alert')).toHaveTextContent(/field|available/i);
});

it('does not mark opening the summary dialog as an unsaved change', async () => {
 const { client, user, open } = example([retained]); const dialog = await open();
 expect(protectedDraftsFor(client).protecting).toBe(false);
 await user.click(within(dialog).getByRole('button', { name: 'Remove Our measured result' }));
 expect(protectedDraftsFor(client).protecting).toBe(true);
});

it('closes an untouched editor through Save without creating a settings write', async () => {
 const { user, save, open } = example([retained]), dialog = await open();
 await user.click(within(dialog).getByRole('button', { name: 'Save summary' }));
 expect(save).not.toHaveBeenCalled(); expect(screen.queryByRole('dialog', { name: 'Summary · Delivery' })).not.toBeInTheDocument();
});

it('can cancel an incomplete new summary without discarding staged removals', async () => {
 const { user, save, open, choose } = example([retained]), dialog = await open();
 await user.click(within(dialog).getByRole('button', { name: 'Remove Our measured result' }));
 await choose(dialog, 'Summary type', 'Person’s available working time');
 await user.click(within(dialog).getByRole('button', { name: 'Save summary' }));
 expect(save).not.toHaveBeenCalled();
 await user.click(within(dialog).getByRole('button', { name: 'Cancel new summary' }));
 expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
 await user.click(within(dialog).getByRole('button', { name: 'Save summary' }));
 expect(save).toHaveBeenCalledOnce(); expect(save.mock.calls[0]?.[0]).toEqual([]);
});

it('does not allow the active editor to silently exceed four summaries', async () => {
 const widgets = Array.from({ length: 4 }, (_, i) => ({ ...retained, key: `kept_${i}` }));
 const { user, save, open, choose } = example(widgets), dialog = await open();
 await choose(dialog, 'Field', 'Budget');
 await user.click(within(dialog).getByRole('button', { name: 'Save summary' }));
 expect(save).not.toHaveBeenCalled(); expect(within(dialog).getByRole('alert')).toHaveTextContent('four summaries');
});

it('opening an existing summary edit and saving unchanged closes without a write or dirty prompt', async () => {
 const { client, user, save, open } = example([retained]), dialog = await open();
 await user.click(within(dialog).getByRole('button', { name: 'Edit Our measured result' }));
 expect(protectedDraftsFor(client).protecting).toBe(false);
 await user.click(within(dialog).getByRole('button', { name: 'Save summary' }));
 expect(save).not.toHaveBeenCalled(); expect(screen.queryByRole('dialog', { name: 'Summary · Delivery' })).not.toBeInTheDocument();
});

it('does not let deferred validation focus collapse a newly opened person picker', async () => {
 const { user, save, open, choose } = example([retained]), dialog = await open();
 await choose(dialog, 'Summary type', 'Person’s available working time');
 const frames: FrameRequestCallback[] = [];
 vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => { frames.push(callback); return frames.length; });
 await user.click(within(dialog).getByRole('button', { name: 'Save summary' }));
 expect(save).not.toHaveBeenCalled();
 expect(within(dialog).getByRole('alert')).toHaveTextContent('Choose a person');
 const person = within(dialog).getByRole('combobox', { name: 'Person' });
 await user.click(person);
 expect(person).toHaveAttribute('aria-expanded', 'true');
 expect(screen.getByRole('option', { name: 'Анна Тестова' })).toBeVisible();
 // Run any delayed frame work after the user already moved on to the next control.
 await act(async () => { for (const callback of frames.splice(0)) callback(performance.now()); });
 expect(person).toHaveAttribute('aria-expanded', 'true');
 expect(person).toHaveFocus();
 await user.click(screen.getByRole('option', { name: 'Анна Тестова' }));
 expect(person).toHaveTextContent('Анна Тестова');
 await user.click(within(dialog).getByRole('button', { name: 'Save summary' }));
 expect(save).toHaveBeenCalledOnce();
 expect(save.mock.calls[0]?.[0]).toEqual([retained, expect.objectContaining({ kind: 'capacity', membershipId: alphaMembers[0]?.id, range: { kind: 'project_dates' } })]);
});
