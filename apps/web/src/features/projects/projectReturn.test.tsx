import { screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router';
import { expect, it, vi } from 'vitest';
import { renderFieldUi } from '../fields/test/fixtures';
import { rememberProjectReturn, useProjectReturn } from './projectReturn';

it('restores the selected row and horizontal scroll on returning through history', async () => {
  const selection = vi.fn();
  const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  function Project() {
    const location = useLocation(), navigate = useNavigate();
    useProjectReturn('actor', 'workspace', true, selection);
    return <main>
      <div data-task-table-scroll="">
        <table><tbody>
          <tr data-task-row="one" aria-selected="true"><td>One</td></tr>
          <tr data-task-row="two" aria-selected="false"><td>Two</td></tr>
        </tbody></table>
      </div>
      <button onClick={() => { rememberProjectReturn('actor', 'workspace', location.key); void navigate('/related'); }}>Open related task</button>
    </main>;
  }
  function Related() {
    const navigate = useNavigate();
    return <button onClick={() => void navigate(-1)}>Back</button>;
  }
  try {
    const ui = renderFieldUi(<MemoryRouter><Routes><Route path="/" element={<Project />} /><Route path="/related" element={<Related />} /></Routes></MemoryRouter>);
    const table = screen.getByRole('table').parentElement;
    if (!table) throw new Error('Missing table scroll port');
    table.scrollLeft = 150;
    await ui.user.click(screen.getByRole('button', { name: 'Open related task' }));
    await ui.user.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(selection).toHaveBeenCalledWith(['one']));
    expect(screen.getByRole('table').parentElement?.scrollLeft).toBe(150);
    expect(scroll).toHaveBeenCalledOnce();
  } finally { scroll.mockRestore(); }
});
