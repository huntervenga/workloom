import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TaskFeedbackLayer } from './TaskCompletionFeedback';

function Example({ message }: { message: string | null }) {
  return <main><input aria-label="Unsent title" defaultValue="Next task" /><table><tbody><tr><td>Saved task</td></tr></tbody></table>
    <TaskFeedbackLayer>{message ? <div role="status"><span>{message}</span><button>Open task</button></div> : null}</TaskFeedbackLayer></main>;
}
describe('task mutation feedback ownership', () => {
  it('keeps held and confirmed feedback outside table layout without replacing or focusing the current input', () => {
    const ui = render(<Example message={null} />); const input = screen.getByLabelText('Unsent title') as HTMLInputElement;
    input.focus(); input.setSelectionRange(2, 6);
    ui.rerender(<Example message="Saving assignee" />);
    expect(ui.container.querySelector('main')).not.toContainElement(screen.getByRole('status'));
    ui.rerender(<Example message="Assignee saved" />);
    expect(screen.getByRole('status')).toHaveTextContent('Assignee saved'); expect(screen.getByLabelText('Unsent title')).toBe(input);
    expect(input).toHaveFocus(); expect([input.selectionStart, input.selectionEnd]).toEqual([2, 6]); expect(input).toHaveValue('Next task');
    expect(ui.container.querySelectorAll('main > table')).toHaveLength(1);
  });
  it('retains a review action inside its modal accessibility boundary', () => {
    render(<div role="dialog" aria-label="Task details"><TaskFeedbackLayer><button>Review change</button></TaskFeedbackLayer></div>);
    expect(screen.getByRole('dialog', { name: 'Task details' })).toContainElement(screen.getByRole('button', { name: 'Review change' }));
  });
});
