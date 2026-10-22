import type { TaskFieldDefinitionDto, TaskFieldValueDto } from '@workloom/contracts';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { alpha, alphaMembers, anna, installFakeApi } from '../../test/fakeApi';
import { task } from '../planning/test/fixtures';
import { InlineFieldValueCell } from './InlineFieldValueCell';
import { STAMP, field, renderFieldUi } from './test/fixtures';
import { useSetTaskFieldValueMutation } from './queries';
import { useFieldValueDrafts } from './useFieldValueDrafts';

const hours: TaskFieldDefinitionDto = { ...field('Hours Est', 'duration'), projectId: task.projectId };
const own = (minutes: number): TaskFieldValueDto => ({ workspaceId: alpha.id, projectId: task.projectId, taskId: task.id, fieldId: hours.id, definitionVersionId: hours.definitionVersionId, revision: 2, value: { type: 'duration', value: minutes }, updatedAt: STAMP });

function show(value: TaskFieldValueDto | null, writable = true) {
  installFakeApi({});
  function Harness() {
    const mutation = useSetTaskFieldValueMutation(anna.id, alpha.id);
    const owner = useFieldValueDrafts(anna.id, alpha.id, task.projectId, mutation);
    return <InlineFieldValueCell actorId={anna.id} workspaceId={alpha.id} task={task} field={hours} value={value} inherited={{ type: 'duration', value: 90 }}
      members={alphaMembers} writable={writable} mutation={mutation} drafts={owner.current} onMoreDetails={() => undefined} />;
  }
  return renderFieldUi(<Harness />);
}

describe('inherited subtask total in a field cell', () => {
  it('shows the calculated total muted when the task has no value, in editable and read-only cells', () => {
    for (const writable of [true, false]) {
      const view = show(null, writable);
      const calculated = document.querySelector('[data-calculated-from-subtasks]');
      expect(calculated).not.toBeNull();
      expect(calculated?.className).toContain('text-muted');
      expect(calculated?.textContent).toContain('1h 30m');
      view.unmount();
    }
  });
  it('shows the typed value, never the sum, once the task has its own', () => {
    show(own(45));
    expect(document.querySelector('[data-calculated-from-subtasks]')).toBeNull();
    expect(screen.getByRole('button', { name: /Hours Est/ }).textContent).toContain('45m');
  });
});
