import { describe, expect, it } from 'vitest';
import { filterJumpItems, type JumpItem } from './quickJumpItems';

const item = (label: string): JumpItem => ({ key: label, label, hint: '', to: `/x/${label}` });

describe('quick jump filtering', () => {
  const items = [item('Week 42 planning'), item('Billing'), item('Week 42'), item('Reports')];
  it('keeps the order when nothing is typed', () => expect(filterJumpItems(items, '  ').map(i => i.label)).toEqual(items.map(i => i.label)));
  it('needs every typed word, ignores case and puts the shortest name first', () => {
    expect(filterJumpItems(items, 'WEEK 42').map(i => i.label)).toEqual(['Week 42', 'Week 42 planning']);
    expect(filterJumpItems(items, 'week report')).toEqual([]);
  });
});
