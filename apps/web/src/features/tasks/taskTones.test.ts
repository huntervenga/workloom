import { describe, expect, it } from 'vitest';
import { priorityColor, priorityTones, statusTones } from './taskTones';

describe('status and priority tones', () => {
  it('gives the table utility and the picker dot the same theme colour', () => {
    for (const tone of Object.values(statusTones)) expect(tone.color).toBe(`var(--color-${tone.dot.replace(/^bg-/, '')})`);
    for (const tone of Object.values(priorityTones)) expect(tone.color).toBe(`var(--color-${tone.text.replace(/^text-/, '')})`);
  });

  it('draws no dot for "No priority"', () => {
    expect(priorityColor('none')).toBeUndefined();
    expect(priorityColor('urgent')).toBe(priorityTones.urgent.color);
  });
});
