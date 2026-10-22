import { describe, expect, it } from 'vitest';
import { hasDateInName, suggestNextProjectName } from './suggestName';

describe('next project name', () => {
  it('moves the number and the week date', () => {
    expect(suggestNextProjectName('42 week (since 19 October 2026) Hour-Based Planning')).toBe('43 week (since 26 October 2026) Hour-Based Planning');
    expect(suggestNextProjectName('52 week (since 28 December 2026) Plan')).toBe('53 week (since 4 January 2027) Plan');
  });
  it('leaves a name without numbers or dates for the person to edit', () => {
    expect(suggestNextProjectName('Launch')).toBe('Launch');
    expect(hasDateInName('Launch')).toBe(false);
    expect(hasDateInName('1 week (since 5 January 2026)')).toBe(true);
  });
});
