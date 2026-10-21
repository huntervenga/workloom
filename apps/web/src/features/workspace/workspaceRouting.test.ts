import { describe, expect, it } from 'vitest';
import { canonicalWorkspacePath, canonicalWorkspaceTo, resolveWorkspaceReference, workspaceHref } from './workspaceRouting';

const id = 'e25f76fe-efdc-4062-9326-2ad44733dd04';
const other = '22222222-2222-4222-8222-222222222222';
const list = [{ id, slug: 'balancy', slugAliases: ['old-balancy'] }, { id: other }];

describe('company URL aliases', () => {
  it('resolves UUID, current slug and reserved former slug to one UUID', () => {
    for (const ref of [id, id.toUpperCase(), 'balancy', 'BALANCY', 'old-balancy']) expect(resolveWorkspaceReference(ref, list)?.id).toBe(id);
    expect(resolveWorkspaceReference('unknown', list)).toBeUndefined();
    expect(resolveWorkspaceReference('balancy', [{ id: other }])).toBeUndefined();
  });
  it.each(['', '/projects', '/projects/123?view=gantt&task=4#dates', '/projects/123/week?period=&worker=7', '/reports?from=2026-01-01', '/time-off?person=2', '/members', '/my-tasks'])('canonicalizes GUID and old alias without changing child/query/hash %s', suffix => {
    expect(canonicalWorkspacePath(`/w/${id}${suffix}`, list)).toBe(`/w/balancy${suffix}`);
    expect(canonicalWorkspacePath(`/app/w/old-balancy${suffix}`, list)).toBe(`/app/w/balancy${suffix}`);
  });
  it('preserves legacy UUIDs without a configured address and leaves unrelated paths untouched', () => {
    expect(workspaceHref({ id: other }, '/projects')).toBe(`/w/${other}/projects`);
    for (const path of ['https://foreign.test/w/old-balancy', '/api/v1/workspaces/'+id, '/w/unknown/projects', '/w/%E0%A4%A/projects', '/w/old-balancy-more', '../projects', '/join/sensitive-token']) expect(canonicalWorkspacePath(path, list)).toBe(path);
  });
  it('preserves separate To search/hash/state fields and does not mutate input', () => {
    const to = { pathname: `/w/${id}/projects/3`, search: '?worker=7&week=', hash: '#x' };
    expect(canonicalWorkspaceTo(to, list)).toEqual({ ...to, pathname: '/w/balancy/projects/3' });
    expect(to.pathname).toContain(id);
    expect(canonicalWorkspaceTo({ search: '?task=4' }, list)).toEqual({ search: '?task=4' });
  });
});
