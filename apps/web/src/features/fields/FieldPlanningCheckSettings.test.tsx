import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FieldPlanningCheckSettings } from './FieldPlanningCheckSettings';
import { FIELD_ID, renderFieldUi } from './test/fixtures';

describe('field planning check shortcut', () => {
  it('opens the one project editor with the stable field ID without submitting the enclosing field form', async () => {
    const configure = vi.fn(), submit = vi.fn();
    const ui = renderFieldUi(<form onSubmit={event => { event.preventDefault(); submit(); }}><FieldPlanningCheckSettings fieldId={FIELD_ID} fieldName="Effort allowance" onConfigure={configure} /></form>);
    await ui.user.click(screen.getByRole('button', { name: 'Configure planning check for Effort allowance' }));
    expect(configure).toHaveBeenCalledExactlyOnceWith(FIELD_ID);
    expect(submit).not.toHaveBeenCalled();
    expect(screen.getByText(/never block task updates/)).toBeInTheDocument();
  });
  it('does not open a second editor during a pending or unconfirmed field change', async () => {
    const configure = vi.fn();
    const ui = renderFieldUi(<FieldPlanningCheckSettings fieldId={FIELD_ID} fieldName="Effort allowance" disabled onConfigure={configure} />);
    await ui.user.click(screen.getByRole('button', { name: 'Configure planning check for Effort allowance' }));
    expect(configure).not.toHaveBeenCalled();
  });
});
