import { describe, expect, it } from 'vitest';
import { observeWorkspaceCommits, type CommittedWorkspaceChange } from './commit-observer.js';
import { reportCommittedWorkspaceChange } from './commit-observer.js';

describe('workspace commit observer', () => {
  it('reports commits made inside the observed async chain, and nothing outside it', async () => {
    const seen: CommittedWorkspaceChange[] = [];
    reportCommittedWorkspaceChange({ workspaceId: 'w', changeSeq: '1' });
    await observeWorkspaceCommits(change => seen.push(change), async () => {
      await Promise.resolve();
      reportCommittedWorkspaceChange({ workspaceId: 'w', changeSeq: '2' });
      await new Promise(resolve => setTimeout(resolve, 1));
      reportCommittedWorkspaceChange({ workspaceId: 'w', changeSeq: '3' });
    });
    reportCommittedWorkspaceChange({ workspaceId: 'w', changeSeq: '4' });
    expect(seen.map(change => change.changeSeq)).toEqual(['2', '3']);
  });
  it('keeps concurrent observers apart', async () => {
    const a: string[] = [], b: string[] = [];
    await Promise.all([
      observeWorkspaceCommits(c => a.push(c.changeSeq), async () => { await new Promise(r => setTimeout(r, 2)); reportCommittedWorkspaceChange({ workspaceId: 'w', changeSeq: 'a' }); }),
      observeWorkspaceCommits(c => b.push(c.changeSeq), async () => { reportCommittedWorkspaceChange({ workspaceId: 'w', changeSeq: 'b' }); }),
    ]);
    expect([a, b]).toEqual([['a'], ['b']]);
  });
});
