import { render, screen } from '@testing-library/react';
import type { ScheduleDependencyComparisonDto } from '@workloom/contracts';
import { describe, expect, it } from 'vitest';
import { context, taskAt } from '../dependencies/test/fixtures';
import { GanttConnectors } from './GanttConnectors';
import { ScheduleBar } from './GanttView';
import { planConnectors, type ConnectorRow } from './connectors';
import { calendarWindow } from './dates';

const A = taskAt(1), B = taskAt(2);
const window = (() => { const value = calendarWindow('2026-03-01', 28); if (!value) throw new Error('Expected calendar window'); return value; })();
const comparison: ScheduleDependencyComparisonDto = {
  dependencyId: 'd1000000-0000-4000-8000-000000000001',
  predecessorTaskId: A.id, successorTaskId: B.id,
  predecessorDueDate: '2026-03-05', successorStartDate: '2026-03-09',
  predecessorContext: context(A), successorContext: context(B), state: 'compatible',
};
const rangeA: ConnectorRow = { start: '2026-03-02', due: '2026-03-05', meeting: false };
const rangeB: ConnectorRow = { start: '2026-03-09', due: '2026-03-12', meeting: false };
const dueOnly: ConnectorRow = { ...rangeA, start: null };
const startOnly: ConnectorRow = { ...rangeB, due: null };

/** Read the styles actually applied by ScheduleBar, independently of the planner's geometry constants. */
function renderedBounds(shape: HTMLElement | null, trackWidth: number) {
  if (!shape) throw new Error('Expected rendered date shape');
  const left = parseFloat(shape.style.left) / 100 * trackWidth;
  if (shape.tagName === 'DIV') return { left, right: left + parseFloat(shape.style.width) / 100 * trackWidth };
  const width = parseFloat(shape.style.width), height = parseFloat(shape.style.height);
  expect(shape.style.translate).toBe('-50%');
  const angle = parseFloat(shape.style.rotate) * Math.PI / 180;
  expect([width, height, angle].every(Number.isFinite)).toBe(true);
  // A rotated rectangle's horizontal bounding-box width is |w cosθ| + |h sinθ|.
  const halfWidth = (Math.abs(width * Math.cos(angle)) + Math.abs(height * Math.sin(angle))) / 2;
  return { left: left - halfWidth, right: left + halfWidth };
}

for (const dayWidth of [12, 20, 36]) {
  describe(`rendered connector endpoints at ${dayWidth}px per day`, () => {
    it.each([
      ['due-only to range', dueOnly, rangeB],
      ['range to start-only', rangeA, startOnly],
      ['due-only to start-only', dueOnly, startOnly],
    ] as const)('touches the actual rendered bounds: %s', (_name, predecessor, successor) => {
      const plan = planConnectors([comparison], new Map([[A.id, predecessor], [B.id, successor]]), window, dayWidth);
      const trackLeft = 153.25;
      const view = render(<>
        <div data-testid="predecessor"><ScheduleBar {...predecessor} window={window} onFocus={() => undefined} /></div>
        <div data-testid="successor"><ScheduleBar {...successor} window={window} onFocus={() => undefined} /></div>
        <GanttConnectors plan={plan} anchors={{ [A.id]: { trackLeft, y: 20 }, [B.id]: { trackLeft, y: 70 } }} label="Measured dependency" />
      </>);
      const from = renderedBounds(view.getByTestId('predecessor').querySelector<HTMLElement>('[role="img"]'), window.days * dayWidth);
      const to = renderedBounds(view.getByTestId('successor').querySelector<HTMLElement>('[role="img"]'), window.days * dayWidth);
      expect(plan.drawn[0]?.from.x).toBeCloseTo(from.right, 10);
      expect(plan.drawn[0]?.to.x).toBeCloseTo(to.left, 10);
      const svg = screen.getByRole('img', { name: 'Measured dependency' });
      const paths = svg.querySelectorAll('path');
      const round = (value: number) => Math.round(value * 10) / 10;
      expect(paths[0]?.getAttribute('d')?.startsWith(`M${round(trackLeft + from.right)},20H`)).toBe(true);
      expect(paths[0]?.getAttribute('d')?.endsWith(`H${round(trackLeft + to.left)}`)).toBe(true);
      expect(paths[1]?.getAttribute('d')?.startsWith(`M${round(trackLeft + to.left)},70L`)).toBe(true);
    });
  });
}
