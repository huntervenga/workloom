import { describe, expect, it } from 'vitest';
import { selectTaskRows } from './taskSelection';

describe('visible row selection', () => {
  it('ranges only through visible saved rows and supports additive reverse ranges', () => {
    expect(selectTaskRows(['hidden'], ['a', 'c', 'd'], 'd', 'a', { shiftKey: true }).ids).toEqual(['a', 'c', 'd']);
    expect(selectTaskRows(['hidden'], ['a', 'c', 'd'], 'd', 'c', { shiftKey: true, metaKey: true }).ids).toEqual(['hidden', 'c', 'd']);
  });
  it('refuses an oversized range without silently truncating the intended selection', () => {
    const ids = Array.from({ length: 101 }, (_, n) => String(n));
    expect(selectTaskRows(['0'], ids, '0', '100', { shiftKey: true })).toEqual({ ids: ['0'], anchor: '0', limitReached: true });
    expect(selectTaskRows(ids.slice(0, 100), ids, '0', '100', { ctrlKey: true }).ids).toHaveLength(100);
  });
  it('ignores a task no longer visible and plain selection clears older hidden selections', () => {
    expect(selectTaskRows(['old'], ['a'], 'old', 'gone', {}).ids).toEqual(['old']);
    expect(selectTaskRows(['old'], ['a'], 'old', 'a', {}).ids).toEqual(['a']);
  });
});
