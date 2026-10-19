import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../lib/queryClient';
import { ProjectUndoSurface } from './ProjectUndoSurface';
import { projectUndoFor, undoScope } from './projectUndo';
import type { UndoEntry } from './UndoStore';
const props={actorId:'actor',workspaceId:'workspace',projectId:'project',writable:true};
const scope=undoScope(props.actorId,props.workspaceId,props.projectId);
function setup(){const client=createQueryClient({retry:false}),store=projectUndoFor(client);render(<QueryClientProvider client={client}><ProjectUndoSurface {...props}/><input aria-label="Native title"/></QueryClientProvider>);return{store};}
function entry(kind:UndoEntry['kind']='edit',execute=vi.fn(async()=>({task:3}))):UndoEntry{return{id:crypto.randomUUID(),scope,kind,heads:{task:2},beforeHeads:{task:1},prepare:()=>execute};}
afterEach(()=>vi.useRealTimers());
describe('project keyboard undo and critical feedback',()=>{
  it('keeps ordinary edits silent and offers archive Undo for5seconds without deleting keyboard history',async()=>{
    vi.useFakeTimers();const{store}=setup();act(()=>store.record(entry()));expect(screen.queryByRole('status')).not.toBeInTheDocument();
    const execute=vi.fn(async()=>({task:3}));act(()=>store.record(entry('archive',execute)));expect(screen.getByRole('button',{name:'Undo'})).toBeInTheDocument();
    act(()=>vi.advanceTimersByTime(5000));expect(screen.queryByRole('status')).not.toBeInTheDocument();expect(store.getSnapshot().count).toBe(2);
    await act(async()=>{fireEvent.keyDown(document.body,{key:'z',metaKey:true});});expect(execute).toHaveBeenCalledTimes(1);expect(screen.getByText('Change undone')).toBeInTheDocument();
  });
  it('disables undo during transient readonly refresh without losing same-context history',async()=>{
    const client=createQueryClient({retry:false}),store=projectUndoFor(client),execute=vi.fn(async()=>({task:3}));
    const ui=(writable:boolean)=><QueryClientProvider client={client}><ProjectUndoSurface {...props} writable={writable}/></QueryClientProvider>;
    const view=render(ui(true));act(()=>store.record(entry('edit',execute)));view.rerender(ui(false));
    await act(async()=>{fireEvent.keyDown(document.body,{key:'z',ctrlKey:true});});expect(execute).not.toHaveBeenCalled();expect(store.getSnapshot().count).toBe(1);
    view.rerender(ui(true));await act(async()=>{fireEvent.keyDown(document.body,{key:'z',ctrlKey:true});});expect(execute).toHaveBeenCalledTimes(1);
  });
  it('preserves native input undo and ignores IME, held repeat, redo and alternate shortcuts',async()=>{
    const{store}=setup(),execute=vi.fn(async()=>({task:3}));act(()=>store.record(entry('edit',execute)));
    await act(async()=>{
      fireEvent.keyDown(screen.getByRole('textbox'),{key:'z',ctrlKey:true});
      for(const extra of[{repeat:true},{isComposing:true},{shiftKey:true},{altKey:true}])fireEvent.keyDown(document.body,{key:'z',ctrlKey:true,...extra});
    });expect(execute).not.toHaveBeenCalled();
    await act(async()=>{fireEvent.keyDown(document.body,{key:'z',ctrlKey:true});});expect(execute).toHaveBeenCalledTimes(1);
  });
});
