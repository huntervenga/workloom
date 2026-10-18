import { describe, expect, it } from 'vitest';
import { defaultTagColor, TAG_COLORS, tagColor } from './tagColors';

describe('tag palette presentation', () => {
  it('chooses a stable palette accent without changing a legacy null or using its mutable name', () => {
    const tag = { id: 'stable-tag-id', name: 'Original', color: null };
    expect(tagColor(tag)).toBe(tagColor({ ...tag, name: 'Renamed' }));
    expect(TAG_COLORS.map(item => item.color)).toContain(tagColor(tag));
    expect(tag.color).toBeNull();
  });
  it('honors persisted colors and rejects malformed CSS values', () => {
    expect(tagColor({ id: 'id', name: 'Name', color: '#A1B2C3' })).toBe('#a1b2c3');
    expect(tagColor({ id: 'id', name: 'Name', color: 'red;display:none' })).toBe(defaultTagColor('id'));
  });
  it('is deterministic across whitespace/case and produces more than one accent for ordinary IDs', () => {
    expect(defaultTagColor(' Name ')).toBe(defaultTagColor('name'));
    expect(new Set(['a','b','c','d','e','f'].map(defaultTagColor)).size).toBeGreaterThan(1);
  });
});
