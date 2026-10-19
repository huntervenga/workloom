import { describe, expect, it } from 'vitest';
import { field } from '../fields/test/fixtures';
import { alphaMembers } from '../../test/fakeApi';
import { discovery } from './test/fixtures';
import { dashboardSearch, dashboardSelection, defaultDashboardInput, WORKSPACE_REPORT_QUERY } from './state';
const CATEGORY = 'ed000000-0000-4000-8000-000000000009';
describe('workspace dashboard URL scope', () => {
  it('uses trusted workspace today and stable report IDs, preferring an existing category mapping within a project', () => {
    const data = discovery(); const first = data.sources[0]; if (!first) throw new Error('fixture');
    data.sources.push({ ...first, fields: [...first.fields, { ...field('Focus area', 'single_select', CATEGORY), projectId: first.projectId }], report: { ...first.report, id: CATEGORY, name: 'Category review', config: { ...first.report.config, groupBy: { kind: 'category', fieldId: CATEGORY } } } });
    const input = defaultDashboardInput(data); expect(input?.sources).toEqual([{ reportId: CATEGORY, expectedRevision: 1 }]);
    expect(input?.range).toEqual({ from: '2026-07-21', to: '2026-10-20' }); expect(input?.people).toEqual({ kind: 'all_active' });
  });
  it('uses an explicit no-category default for a stale saved category, but does not repair an explicit link', () => {
    const data = discovery(), first = data.sources[0]; if (!first) throw new Error('fixture');
    data.sources = [{ ...first, report: { ...first.report, config: { ...first.report.config, groupBy: { kind: 'category', fieldId: CATEGORY } } } }];
    expect(defaultDashboardInput(data)?.sources).toEqual([{ reportId: first.report.id, expectedRevision: 1, categoryFieldId: null }]);
    const input = defaultDashboardInput(data); if (!input) throw new Error('fixture');
    const explicit = { ...input, sources: [{ reportId: first.report.id, expectedRevision: 1, categoryFieldId: CATEGORY }] };
    expect(dashboardSelection(dashboardSearch(new URLSearchParams(), explicit), data)).toEqual({ kind: 'valid', input: explicit });
  });
  it('roundtrips arbitrary inclusive dates, a person, categories and display bucket without losing other URL parameters', () => {
    const base = defaultDashboardInput(discovery()); if (!base) throw new Error('fixture');
    const input = { ...base, bucket: 'month' as const, range: { from: '2026-02-01', to: '2026-05-31' }, people: { kind: 'selected' as const, membershipIds: [alphaMembers[0]?.id ?? ''] }, sources: base.sources.map(source => ({ ...source, categoryFieldId: CATEGORY })) };
    const params = dashboardSearch(new URLSearchParams('keep=yes'), input);
    expect(params.get('keep')).toBe('yes'); expect(dashboardSelection(new URLSearchParams(params.toString()), discovery())).toEqual({ kind: 'valid', input });
  });
  it('does not replace malformed or duplicate explicit scope with a broad default', () => {
    const base = defaultDashboardInput(discovery()); if (!base) throw new Error('fixture');
    for (const value of ['invalid', '{}', JSON.stringify({ ...base, range: { from: '2026-10-20', to: '2026-10-19' } }), JSON.stringify({ ...base, sources: [] }), JSON.stringify({ ...base, expectedSourceVersion: 'a'.repeat(64) })]) {
      expect(dashboardSelection(new URLSearchParams({ [WORKSPACE_REPORT_QUERY]: value }), discovery())).toEqual({ kind: 'invalid' });
    }
    const duplicate = dashboardSearch(new URLSearchParams(), base); duplicate.append(WORKSPACE_REPORT_QUERY, JSON.stringify(base)); expect(dashboardSelection(duplicate, discovery())).toEqual({ kind: 'invalid' });
  });
  it('keeps empty discovery distinct from zero reported hours and bounds a default selection at 20 projects', () => {
    const data = discovery(); expect(dashboardSelection(new URLSearchParams(), { ...data, sources: [] })).toEqual({ kind: 'empty' });
    const source = data.sources[0]; if (!source) throw new Error('fixture');
    data.sources = Array.from({ length: 21 }, (_, index) => ({ ...source, projectId: `e0000000-0000-4000-8000-${String(index).padStart(12, '0')}`, report: { ...source.report, id: `f0000000-0000-4000-8000-${String(index).padStart(12, '0')}` } }));
    expect(defaultDashboardInput(data)?.sources).toHaveLength(20); expect(data.sources).toHaveLength(21);
  });
});
