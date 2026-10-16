import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../lib/queryClient';
import { alpha, anna, deferred, installFakeApi } from '../../test/fakeApi';
import type { CsvFileSource } from './file';
import { useImportWorkspace } from './useImportWorkspace';
import { PROJECT_ID } from './test/fixtures';
const valid = (): CsvFileSource => { const bytes = new TextEncoder().encode('ID,Name\n001,Task\n'); return { name: 'a.csv', size: bytes.length, arrayBuffer: async () => bytes.buffer as ArrayBuffer }; };
describe('upload selection identity', () => {
  it('clears the prior valid file immediately when a new invalid UTF-8 file is selected, so staging cannot send A', async () => {
    const { calls } = installFakeApi({}); const client = createQueryClient({ retry: false });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const view = renderHook(() => useImportWorkspace(anna.id, alpha.id, PROJECT_ID, '', vi.fn()), { wrapper });
    await act(async () => { await view.result.current.chooseFile(valid()); });
    act(() => view.result.current.setNamespace('asana:pilot'));
    expect(view.result.current.upload.file?.fileName).toBe('a.csv');
    const bytes = deferred<ArrayBuffer>(); let reading: Promise<void> | undefined;
    act(() => { reading = view.result.current.chooseFile({ name: 'b.csv', size: 2, arrayBuffer: () => bytes.promise }); });
    expect(view.result.current.upload.file).toBeNull();
    act(() => view.result.current.stage());
    await act(async () => { bytes.resolve(Uint8Array.of(0xc3, 0x28).buffer); await reading; });
    expect(view.result.current.fileError).not.toBeNull();
    act(() => view.result.current.stage());
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(0);
    expect(view.result.current.upload.file).toBeNull();
    view.unmount(); client.clear();
  });
  it('keeps unknown native file failures out of user copy and cannot stage the failed selection', async () => {
    const { calls } = installFakeApi({}); const client = createQueryClient({ retry: false });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const view = renderHook(() => useImportWorkspace(anna.id, alpha.id, PROJECT_ID, '', vi.fn()), { wrapper });
    await act(async () => { await view.result.current.chooseFile({ name: 'unreadable.csv', size: 20, arrayBuffer: async () => { throw new Error('native diagnostic containing private path'); } }); });
    expect(view.result.current.fileError).toBe('Could not read the file.');
    expect(view.result.current.upload.file).toBeNull();
    act(() => view.result.current.stage());
    expect(calls).toHaveLength(0);
    view.unmount(); client.clear();
  });

});
