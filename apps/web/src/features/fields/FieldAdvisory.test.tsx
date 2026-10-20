import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FieldAdvisoryIndicator, fieldAdvisoryStyle, type FieldAdvisory } from './FieldAdvisory';

const issue: FieldAdvisory = { state: 'missing', label: 'Effort allowance is not filled', severity: 'warning', color: '#ffffff' };

describe('read-only field advisories', () => {
  it('shows a named issue icon without claiming the input is required or invalid', () => {
    const { container } = render(<FieldAdvisoryIndicator advisory={issue} />);
    expect(screen.getByRole('img', { name: 'Warning: Effort allowance is not filled' })).toHaveAttribute('title', 'Warning: Effort allowance is not filled');
    expect(container.querySelector('[aria-required], [aria-invalid], button, input')).toBeNull();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it.each([null, { ...issue, state: 'unavailable' as const }])('stays neutral when the server has no usable issue assessment', advisory => {
    const { container } = render(<FieldAdvisoryIndicator advisory={advisory} />);
    expect(container).toBeEmptyDOMElement();
    expect(fieldAdvisoryStyle(advisory)).toBeUndefined();
  });
  it('tints only the background so white and low-contrast custom colors cannot hide the text or issue icon', () => {
    expect(fieldAdvisoryStyle(issue)).toEqual({ backgroundColor: '#ffffff18' });
    render(<FieldAdvisoryIndicator advisory={{ ...issue, severity: 'critical' }} />);
    expect(screen.getByRole('img', { name: 'Needs attention: Effort allowance is not filled' })).toHaveClass('bg-surface', 'text-ink');
  });
  it('never interpolates arbitrary CSS from a malformed color', () => {
    expect(fieldAdvisoryStyle({ ...issue, color: 'url(https://example.com)' })).toEqual({ backgroundColor: '#d9770618' });
  });
});
