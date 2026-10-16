import { QueryClientProvider } from '@tanstack/react-query';
import { render, renderHook, screen } from '@testing-library/react';
import type { ProjectImportIssueDto } from '@workloom/contracts';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../lib/queryClient';
import { alpha, anna, installFakeApi } from '../../test/fakeApi';
import { ImportPreview } from './ImportResults';
import { importIssueCopy } from './issueCopy';
import { formFromMapping } from './mapping';
import { useImportWorkspace } from './useImportWorkspace';
import { PROJECT_ID, durationField, mapping, preview, source } from './test/fixtures';

describe('localized import issue boundary', () => {
  it('renders fixed issue guidance by public code while preserving source content and row context', () => {
    const { calls } = installFakeApi({});
    const client = createQueryClient({ retry: false });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const hook = renderHook(() => useImportWorkspace(anna.id, alpha.id, PROJECT_ID, '', vi.fn()), { wrapper });
    const staged = source();
    const form = formFromMapping(mapping());
    const result = preview(mapping());
    const untrustedMessage = 'Opaque server message with private details';
    result.issues = [{ severity: 'blocking', code: 'private_source', rowNumber: 1, column: 1, message: untrustedMessage }];
    render(<ImportPreview result={result} source={staged} catalog={{ members: [], statuses: [], sections: [], tags: [], fields: [durationField()] }} controller={hook.result.current} draft={{ id: 'draft', source: staged, form, baseForm: JSON.stringify(form), preview: result, previewFingerprint: null, error: null }} onOpenTask={vi.fn()} onRecovery={vi.fn()} />);
    expect(screen.getByText('This source row is explicitly private and cannot be imported into this workspace-visible pilot.')).toBeInTheDocument();
    expect(screen.queryByText(untrustedMessage)).not.toBeInTheDocument();
    expect(screen.getByText('Blocks import · row 1 · column 2: Name')).toBeInTheDocument();
    expect(screen.getByText('000900719925474099312345')).toBeInTheDocument();
    expect(calls).toHaveLength(0);
    hook.unmount(); client.clear();
  });

  it('uses fixed fallback guidance for an unrecognized issue code, including prototype names', () => {
    expect(importIssueCopy({ code: '__proto__' as ProjectImportIssueDto['code'] })).toBe('This import issue needs attention. Check the affected row and column, then refresh the preview.');
  });
});
