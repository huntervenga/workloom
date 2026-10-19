import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { anna } from '../../test/fakeApi';
import { LeaveSettingsEditor } from './LeaveSettingsEditor';
import { LeaveProfileEditor } from './LeaveProfileEditor';
import { MEMBER, profile, settings } from './test/fixtures';
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
