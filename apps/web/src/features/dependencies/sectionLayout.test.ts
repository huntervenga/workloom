import type { SectionDto } from '@workloom/contracts';
import { describe, expect, it } from 'vitest';
import type { GraphNodeSize } from './GraphNodeContent';
import { arrangeGraphBySections, type SectionLayoutTask } from './sectionLayout';
const section = (id: string, position: number, name = id): SectionDto => ({ id, position, name, projectId: 'p', workspaceId: 'w', revision: 1, archivedAt: null });
const task = (id: string, sectionId: string | null, position = 0, projectId = 'p'): SectionLayoutTask => ({ id, sectionId, position, projectId, projectName: projectId });
const sizes = (tasks: readonly SectionLayoutTask[]) => Object.fromEntries(tasks.map((item, i) => [item.id, { width: 240, height: 128 + i * 20 }]));

describe('real-section graph column layout', () => {
  it('orders real sections horizontally and task positions vertically, independently of input/UUID order', () => {
    const tasks = [task('z', 'later', 4), task('b', 'first', 3), task('a', 'first', 1), task('c', 'later', 2)];
    const sections = [section('later', 20, 'Delivery'), section('first', 10, 'Discovery')];
    const measured = sizes(tasks), before = structuredClone({ tasks, sections, measured });
    const result = arrangeGraphBySections(tasks, 'p', sections, measured);
    expect(result.columns.map(item => item.title)).toEqual(['Discovery', 'Delivery']);
    expect(result.positions.a).toEqual({ x: 24, y: 120 });
    expect(result.positions.b).toEqual({ x: 24, y: 120 + 168 + 36 });
    expect(result.positions.c?.x).toBe(360); expect(result.positions.z?.x).toBe(360);
    expect(result.positions.c?.y).toBeLessThan(result.positions.z?.y ?? 0);
    expect(arrangeGraphBySections([...tasks].reverse(), 'p', [...sections].reverse(), measured)).toEqual(result);
    expect({ tasks, sections, measured }).toEqual(before);
  });
  it('uses own task sections, separates unsectioned/unavailable and external project neighbors without guessing foreign sections', () => {
    const tasks = [task('child', null), task('parent', 's'), task('missing', 'deleted'), task('foreign', 's', 0, 'other')];
    const result = arrangeGraphBySections(tasks, 'p', [section('s', 0, 'Build')], sizes(tasks));
    expect(result.columns.map(item => [item.title, item.count])).toEqual([['Build', 1], ['Unsectioned', 1], ['Unavailable section', 1], ['Other project · other', 1]]);
    expect(result.positions.child?.x).not.toBe(result.positions.parent?.x);
    expect(Object.keys(result.positions).sort()).toEqual(['child', 'foreign', 'missing', 'parent']);
  });
  it('keeps measured rectangles and headers disjoint for all 500 supported tasks without compression', () => {
    const tasks = Array.from({ length: 500 }, (_, i) => task(`task-${i}`, `s${i % 5}`, i));
    const measured = Object.fromEntries(tasks.map((item, i) => [item.id, { width: 240 + i % 3 * 10, height: 128 + i % 4 * 50 }]));
    const result = arrangeGraphBySections(tasks, 'p', Array.from({ length: 5 }, (_, i) => section(`s${i}`, i)), measured);
    expect(Object.keys(result.positions)).toHaveLength(500); expect(result.columns).toHaveLength(5);
    expect(result.columns.every((column, i) => !result.columns[i + 1] || column.x + column.width < (result.columns[i + 1]?.x ?? 0))).toBe(true);
    for (const column of result.columns) {
      const members = tasks.filter(item => result.positions[item.id]?.x === column.x).sort((a, b) => a.position - b.position);
      expect(members).toHaveLength(100);
      expect(members.every((item, i) => {
        const point = result.positions[item.id], size = measured[item.id], next = members[i + 1];
        if (!point || !size) return false;
        return point.y >= column.y + 80 && point.x + size.width <= column.x + column.width && point.y + size.height <= 100000 && (!next || point.y + size.height < (result.positions[next.id]?.y ?? 0));
      })).toBe(true);
    }
  });
  it('rejects missing/nonfinite dimensions and an unfit measured stack without clipping or scaling', () => {
    const tasks = [task('a', 's')];
    const invalid: Readonly<Record<string, GraphNodeSize>>[] = [{}, { a: { width: 0, height: 10 } }, { a: { width: NaN, height: 10 } }];
    for (const measured of invalid) expect(() => arrangeGraphBySections(tasks, 'p', [section('s', 0)], measured)).toThrow();
    expect(() => arrangeGraphBySections(tasks, 'p', [section('s', 0)], { a: { width: 240, height: 200001 } })).toThrow();
  });
  it('handles empty selections, finite tie ordering and invalid order metadata deterministically', () => {
    expect(arrangeGraphBySections([], 'p', [], {})).toEqual({ positions: {}, columns: [] });
    const tasks = [task('b', 'b', Infinity), task('a', 'a', NaN)];
    const result = arrangeGraphBySections(tasks, 'p', [section('b', NaN), section('a', Infinity)], sizes(tasks));
    expect(result.columns.map(item => item.title)).toEqual(['a', 'b']);
    expect(Object.values(result.positions).every(point => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
  });
});
