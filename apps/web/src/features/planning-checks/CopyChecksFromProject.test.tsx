import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PlanningCheckRuleDto, SectionDto, TaskFieldDefinitionDto } from '@workloom/contracts';
import { alpha, installFakeApi, ok, project, anna } from '../../test/fakeApi';
import { field, renderFieldUi } from '../fields/test/fixtures';
import { CopyChecksFromProject } from './CopyChecksFromProject';

const TARGET = '70000000-0000-4000-8000-000000000001';
const SOURCE = '70000000-0000-4000-8000-000000000002';
const f = (id: string, name: string, projectId: string): TaskFieldDefinitionDto => ({ ...field(name, 'duration', id), projectId });
const rule = (fieldId: string, name = 'Estimate missing', id = '70000000-0000-4000-8000-0000000000a1'): PlanningCheckRuleDto => ({ id, kind: 'presence', name, color: '#dc2626', enabled: true, hierarchy: 'all_tasks', severity: 'warning', fieldId, filters: { statusGroups: ['todo'], tagIds: [], assignee: { kind: 'all' }, dateRange: null } });

describe('copy checks from another project', () => {
  it('adds mapped checks to the draft, lists the skipped ones and saves nothing', async () => {
    const onCopy = vi.fn();
    const base = `/api/v1/workspaces/${alpha.id}`;
    const api = installFakeApi({
      [`GET ${base}/projects`]: () => ok([project(alpha.id, TARGET, 'Week 42'), project(alpha.id, SOURCE, 'Week 41')]),
      [`GET ${base}/projects/${SOURCE}/planning-checks/settings`]: () => ok({ workspaceId: alpha.id, projectId: SOURCE, revision: 3, config: { enabled: true, rules: [rule('70000000-0000-4000-8000-0000000000b1'), rule('70000000-0000-4000-8000-0000000000b2', 'Fact missing', '70000000-0000-4000-8000-0000000000a2')] } }),
      [`GET ${base}/fields`]: request => ok(request.searchParams.get('projectId') === SOURCE ? [f('70000000-0000-4000-8000-0000000000b1', 'Hours Est', SOURCE), f('70000000-0000-4000-8000-0000000000b2', 'Hours Fact', SOURCE)] : []),
      [`GET ${base}/projects/${SOURCE}/sections`]: () => ok([] satisfies SectionDto[]),
    });
    const ui = renderFieldUi(<CopyChecksFromProject actorId={anna.id} workspaceId={alpha.id} projectId={TARGET} existing={[]} targetFields={[f('70000000-0000-4000-8000-0000000000c1', 'hours est', TARGET), f('70000000-0000-4000-8000-0000000000c2', 'Actual', TARGET)]} targetSections={[]} disabled={false} onCopy={onCopy} />);
    expect(api.calls).toHaveLength(0);
    await ui.user.click(screen.getByRole('button', { name: /Copy checks from another project/ }));
    await ui.user.selectOptions(await screen.findByLabelText('Copy from'), SOURCE);
    await ui.user.click(screen.getByRole('button', { name: 'Review' }));
    expect(await screen.findByText(/Fact missing” skipped: no field/)).toBeInTheDocument();
    expect(onCopy).not.toHaveBeenCalled();
    // The names differ ("Hours Fact" vs "Actual"), so the person picks the counterpart.
    await ui.user.selectOptions(await screen.findByLabelText(/“Hours Fact” has no field of the same name/), '70000000-0000-4000-8000-0000000000c2');
    await ui.user.click(screen.getByRole('button', { name: 'Add 2 check(s) to the draft' }));
    expect(onCopy).toHaveBeenCalledTimes(1);
    const copied = onCopy.mock.calls[0]?.[0] as PlanningCheckRuleDto[];
    expect(copied.map(rule => [rule.name, (rule as { fieldId: string }).fieldId])).toEqual([['Estimate missing', '70000000-0000-4000-8000-0000000000c1'], ['Fact missing', '70000000-0000-4000-8000-0000000000c2']]);
    expect(copied.every(rule => !['70000000-0000-4000-8000-0000000000a1', '70000000-0000-4000-8000-0000000000a2'].includes(rule.id))).toBe(true);
    expect(api.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  });
});
