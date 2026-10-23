import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CopyTaskLink, taskLink } from './CopyTaskLink';

describe('copy task link', () => {
  it('builds the address that opens the task in its project', () => {
    expect(taskLink('https://example.com', 'w1', 'p1', 't1')).toBe('https://example.com/app/w/w1/projects/p1?task=t1');
  });
  it('puts that address on the clipboard and says so, or says it could not', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    render(<CopyTaskLink workspaceId="w1" projectId="p1" taskId="t1" />);
    await user.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/app/w/w1/projects/p1?task=t1`);
    expect(await screen.findByText('Link copied')).toBeInTheDocument();
    writeText.mockRejectedValueOnce(new Error('denied'));
    await user.click(screen.getByRole('button', { name: 'Copy link' }));
    await waitFor(() => expect(screen.getByText('Could not copy the link')).toBeInTheDocument());
  });
});
