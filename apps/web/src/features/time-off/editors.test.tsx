import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { anna, installFakeApi, ok } from '../../test/fakeApi';
import { LeaveSettingsEditor } from './LeaveSettingsEditor';
import { LeaveProfileEditor } from './LeaveProfileEditor';
import { MEMBER, prefix, profile, settings, VACATION } from './test/fixtures';
function provider(client: QueryClient) { return function Wrapper({children}:{children:ReactNode}) { return <QueryClientProvider client={client}>{children}</QueryClientProvider>; }; }
describe('leave editor authoritative revisions',()=>{
 it('adopts clean external policy changes and preserves dirty edits until explicit latest reload',async()=>{
  const client=new QueryClient();const user=userEvent.setup();const onSave=vi.fn();const editor=(revision:number,timezone:string)=><LeaveSettingsEditor actorId={anna.id} settings={{...settings(revision),timezone}} disabled={false} onSave={onSave}/>;
  const view=render(editor(1,'UTC'),{wrapper:provider(client)});view.rerender(editor(2,'Asia/Nicosia'));expect(screen.getByLabelText('Timezone')).toHaveValue('Asia/Nicosia');await user.clear(screen.getByLabelText('Timezone'));await user.type(screen.getByLabelText('Timezone'),'Europe/London');view.rerender(editor(3,'Europe/Moscow'));expect(screen.getByLabelText('Timezone')).toHaveValue('Europe/London');expect(screen.getByRole('status')).toHaveTextContent('changed elsewhere');await user.click(screen.getByRole('button',{name:'Load latest and discard local edits'}));expect(screen.getByLabelText('Timezone')).toHaveValue('Europe/Moscow');expect(onSave).not.toHaveBeenCalled();view.unmount();client.clear();
 });
 it('adopts clean external profile changes and does not overwrite a local schedule draft',async()=>{
  const client=new QueryClient();const user=userEvent.setup();const editor=(revision:number,timezone:string)=><LeaveProfileEditor actorId={anna.id} membershipId={MEMBER} profile={{...profile(MEMBER,revision),timezone}} settings={settings()} today="2026-10-19" disabled={false} onSave={vi.fn()}/>;
  const view=render(editor(1,'UTC'),{wrapper:provider(client)});view.rerender(editor(2,'Asia/Nicosia'));expect(screen.getByLabelText('Timezone')).toHaveValue('Asia/Nicosia');await user.clear(screen.getByLabelText('Timezone'));await user.type(screen.getByLabelText('Timezone'),'Europe/London');view.rerender(editor(3,'Europe/Moscow'));expect(screen.getByLabelText('Timezone')).toHaveValue('Europe/London');await user.click(screen.getByRole('button',{name:'Load latest and discard local edits'}));expect(screen.getByLabelText('Timezone')).toHaveValue('Europe/Moscow');view.unmount();client.clear();
 });
});

describe('employment defaults and optional opening balances', () => {
 it('tracks hire date and the untouched default schedule without an opening balance', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); const user = userEvent.setup(); const onSave = vi.fn();
  const { calls } = installFakeApi({ [`POST ${prefix}/members/${MEMBER}/profile/preview`]: () => ok({ sourceVersion: 'a'.repeat(64), balancesBefore: [], balancesAfter: [], deficits: [] }) });
  const view = render(<LeaveProfileEditor actorId={anna.id} membershipId={MEMBER} profile={undefined} settings={settings()} today="2026-10-19" disabled={false} onSave={onSave}/>, { wrapper: provider(client) });
  expect(screen.queryByLabelText('Balance accounting starts')).not.toBeInTheDocument();
  expect(screen.getByText('Advanced import settings', { selector: 'summary' }).parentElement).not.toHaveAttribute('open');
  fireEvent.change(screen.getByLabelText('Employment start'), { target: { value: '2026-01-01' } });
  expect(screen.getByLabelText('Effective from')).toHaveValue('2026-01-01');
  await user.click(screen.getByRole('button', { name: 'Review changes' })); await user.click(await screen.findByRole('button', { name: 'Save person settings' }));
  expect(calls[0]?.body).toMatchObject({ employmentStart: '2026-01-01', accountingStart: '2026-01-01', openingBalances: [], schedulePeriods: [{ effectiveFrom: '2026-01-01', weeklyMinutes: [480,480,480,480,480,0,0] }] });
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ accountingStart: '2026-01-01', openingBalances: [] }));
  view.unmount(); client.clear();
 });
 it('allows an untouched new profile and keeps an equivalent persisted profile clean', async () => {
  const client = new QueryClient(); const user = userEvent.setup();
  const view = render(<LeaveProfileEditor actorId={anna.id} membershipId={MEMBER} profile={undefined} settings={settings()} today="2026-10-19" disabled={false} onSave={vi.fn()}/>, { wrapper: provider(client) });
  expect(screen.getByRole('button', { name: 'Review changes' })).toBeEnabled();
  view.unmount();
  const existing = render(<LeaveProfileEditor actorId={anna.id} membershipId={MEMBER} profile={{ ...profile(), openingBalances: [{ typeId: VACATION, microdays: 0 }] }} settings={settings()} today="2026-10-19" disabled={false} onSave={vi.fn()}/>, { wrapper: provider(client) });
  expect(screen.getByRole('button', { name: 'Review changes' })).toBeDisabled();
  await user.click(screen.getByText('Advanced import settings', { selector: 'summary' })); expect(screen.getByRole('checkbox', { name: 'Use opening balance' })).not.toBeChecked();
  await user.type(screen.getByLabelText('Reason for change'), 'A note alone does not change the profile'); expect(screen.getByRole('button', { name: 'Review changes' })).toBeDisabled();
  existing.unmount(); client.clear();
 });
 it('preserves existing import cutovers and buffers until explicitly switched off', async () => {
  const client = new QueryClient(); const user = userEvent.setup(); const { calls } = installFakeApi({ [`POST ${prefix}/members/${MEMBER}/profile/preview`]: () => ok({ sourceVersion: 'a'.repeat(64), balancesBefore: [], balancesAfter: [], deficits: [] }) }); const imported = { ...profile(), accountingStart: '2026-10-01', openingBalances: [{ typeId: VACATION, microdays: 3_000_000 }] };
  const view = render(<LeaveProfileEditor actorId={anna.id} membershipId={MEMBER} profile={imported} settings={settings()} today="2026-10-19" disabled={false} onSave={vi.fn()}/>, { wrapper: provider(client) });
  expect(screen.getByRole('checkbox', { name: 'Use opening balance' })).toBeChecked(); expect(screen.getByLabelText('Balance accounting starts')).toHaveValue('2026-10-01'); expect(screen.getByLabelText('Vacation')).toHaveValue(3);
  fireEvent.change(screen.getByLabelText('Employment start'), { target: { value: '2026-02-01' } });
  expect(screen.getByLabelText('Balance accounting starts')).toHaveValue('2026-10-01'); expect(screen.getByLabelText('Effective from')).toHaveValue('2026-01-01');
  await user.click(screen.getByRole('checkbox', { name: 'Use opening balance' }));
  expect(screen.getByRole('checkbox', { name: 'Use opening balance' })).toBeVisible();
  expect(screen.queryByLabelText('Balance accounting starts')).not.toBeInTheDocument();
  await user.type(screen.getByLabelText('Reason for change'), 'Recalculate from hire date'); await user.click(screen.getByRole('button', { name: 'Review changes' })); await screen.findByRole('button', { name: 'Save person settings' }); expect(calls[0]?.body).toMatchObject({ accountingStart: '2026-02-01', openingBalances: [] });
  await user.click(screen.getByRole('button', { name: 'Discard local changes' }));
  expect(screen.getByRole('checkbox', { name: 'Use opening balance' })).toBeChecked(); expect(screen.getByLabelText('Vacation')).toHaveValue(3);
  view.unmount(); client.clear();
 });
 it('does not replace a new profile schedule after it has been customized', () => {
  const client = new QueryClient(); const view = render(<LeaveProfileEditor actorId={anna.id} membershipId={MEMBER} profile={undefined} settings={settings()} today="2026-10-19" disabled={false} onSave={vi.fn()}/>, { wrapper: provider(client) });
  fireEvent.change(screen.getByLabelText('Effective from'), { target: { value: '2026-02-01' } });
  fireEvent.change(screen.getByLabelText('Employment start'), { target: { value: '2026-01-01' } });
  expect(screen.getByLabelText('Effective from')).toHaveValue('2026-02-01'); fireEvent.click(screen.getByRole('button', { name: 'Discard local changes' })); fireEvent.change(screen.getByLabelText('Employment start'), { target: { value: '2026-01-01' } }); expect(screen.getByLabelText('Effective from')).toHaveValue('2026-01-01'); view.unmount(); client.clear();
 });
});
