import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localization } from '../../i18n';
import type * as LocalizationExports from '../../i18n';
import GraphCanvas, { type GraphCanvasTask } from './GraphCanvas';

// English source shapes for keys the fix introduces; shipped English messages take precedence once they exist.
const fixtures = vi.hoisted(() => ({
  upcomingEnglish: {
    nodeMoved: 'Moving selected node {{direction}} from position, x: {{x}}, y: {{y}}',
    directionLeft: 'left', directionRight: 'right', directionUp: 'up', directionDown: 'down', directionUnknown: 'in a new direction',
    nodeRoleDescription: 'node', edgeRoleDescription: 'edge', handle: 'Handle', miniMap: 'Mini Map',
  },
  german: {
    graphControls: 'Diagrammsteuerung', zoomIn: 'Vergrößern', zoomOut: 'Verkleinern', fitSelectedGraph: 'Ausgewähltes Diagramm einpassen', toggleMovement: 'Bewegung umschalten',
    selectATaskArrowKeysChangeItsPosition: 'DE node instruction', theButtonInsideANodeOpensTheTask: 'DE node instruction without movement', dependencyTheNextTaskStartsAfterThePrevious: 'DE edge instruction',
    nodeMoved: 'Ausgewählter Knoten bewegt sich {{direction}} von Position, x: {{x}}, y: {{y}}',
    directionLeft: 'nach links', directionRight: 'nach rechts', directionUp: 'nach oben', directionDown: 'nach unten', directionUnknown: 'in eine neue Richtung',
    nodeRoleDescription: 'Knoten', edgeRoleDescription: 'Kante', handle: 'Anschlusspunkt', miniMap: 'Übersichtskarte',
  },
}));

vi.mock('../../i18n', async importOriginal => {
  const actual = await importOriginal<typeof LocalizationExports>();
  const { catalogsFromModules } = await import('../../i18n/LocalizationManager');
  const english = import.meta.glob<LocalizationExports.TranslationCatalog>('../../i18n/locales/en/*.json', { eager: true, import: 'default' });
  const path = '../../i18n/locales/en/dependencies.json';
  const shipped = english[path] as LocalizationExports.TranslationCatalog & { graphCanvas: LocalizationExports.TranslationCatalog };
  // German is virtual: no locale resource ships, and the real manager still checks keys and parameters against English.
  const catalogs = catalogsFromModules({ ...english, [path]: { ...shipped, graphCanvas: { ...fixtures.upcomingEnglish, ...shipped.graphCanvas } }, 'virtual/de/dependencies.json': { graphCanvas: fixtures.german } });
  const manager = new actual.LocalizationManager(catalogs);
  return { ...actual, localization: manager, t: manager.t, useTranslation: () => actual.useTranslation(manager) };
});

afterEach(() => { act(() => localization.setLocale('en')); });

const task = (id: string): GraphCanvasTask => ({ id, title: `Task-${id}`, projectName: 'Pilot', statusName: 'todo', statusGroup: 'todo', blocked: false, unresolvedCount: 0, archived: false, violatesCurrentStatus: false });
// Stable props, as with saved full positions: a locale change is the only thing that re-renders the canvas.
const tasks = [task('a'), task('b')];
const edges = [{ id: 'ab', source: 'a', target: 'b' }];
const positions = { a: { x: 1234, y: 5678 }, b: { x: 1600, y: 5678 } };
function renderCanvas() {
  const handlers = { onMove: vi.fn(), onOpen: vi.fn(), onConnect: vi.fn(), onViewBlockers: vi.fn() };
  const view = render(<GraphCanvas tasks={tasks} edges={edges} positions={positions} movable connectable {...handlers} />);
  const liveRegion = () => view.container.querySelector('[aria-live="assertive"]');
  return { ...view, handlers, liveRegion };
}
const nodeDescription = (node: HTMLElement) => document.getElementById(node.getAttribute('aria-describedby') ?? '');

describe('GraphCanvas localized React Flow accessibility', () => {
  it('relabels mounted controls and hidden descriptions on a locale change without remounting or moving', () => {
    const { container, handlers } = renderCanvas();
    const application = screen.getByTestId('rf__wrapper');
    const node = screen.getByTestId('rf__node-a');
    const edgeDescription = () => container.querySelector('[id^="react-flow__edge-desc-"]');
    expect(screen.getByTestId('rf__controls')).toHaveAttribute('aria-label', 'Graph controls');
    expect(screen.getByRole('button', { name: 'Zoom in' })).toHaveAttribute('title', 'Zoom in');
    expect(edgeDescription()).toHaveTextContent('Dependency: the next task starts after the previous task finishes.');

    act(() => localization.setLocale('de'));

    expect(screen.getByTestId('rf__wrapper')).toBe(application);
    expect(screen.getByTestId('rf__node-a')).toBe(node);
    expect(screen.getByTestId('rf__controls')).toHaveAttribute('aria-label', 'Diagrammsteuerung');
    expect(screen.getByRole('button', { name: 'Vergrößern' })).toHaveAttribute('title', 'Vergrößern');
    expect(screen.getByRole('button', { name: 'Verkleinern' })).toHaveAttribute('title', 'Verkleinern');
    expect(screen.getByRole('button', { name: 'Ausgewähltes Diagramm einpassen' })).toHaveAttribute('title', 'Ausgewähltes Diagramm einpassen');
    expect(screen.queryByRole('button', { name: 'Zoom in' })).not.toBeInTheDocument();
    expect(nodeDescription(node)?.textContent).toMatch(/^DE node instruction/);
    expect(edgeDescription()).toHaveTextContent('DE edge instruction');
    expect(node).toHaveAttribute('aria-roledescription', 'Knoten');
    expect(handlers.onMove).not.toHaveBeenCalled();
    expect(handlers.onConnect).not.toHaveBeenCalled();
  });

  it('announces keyboard moves in German after switching from English on the same mounted canvas', () => {
    const { handlers, liveRegion } = renderCanvas();
    const node = screen.getByTestId('rf__node-a');
    expect(liveRegion()).toBeEmptyDOMElement();

    fireEvent.keyDown(node, { key: 'Enter' });
    expect(screen.getByRole('status', { name: 'Selected task dependencies' })).toHaveTextContent('Task-a');
    expect(liveRegion()).toBeEmptyDOMElement();
    expect(handlers.onMove).not.toHaveBeenCalled();

    act(() => localization.setLocale('de'));
    expect(screen.getByTestId('rf__node-a')).toBe(node);
    expect(node).toHaveAttribute('aria-roledescription', 'Knoten');

    // React Flow announces the position before the step, then moves by its native 5px.
    fireEvent.keyDown(node, { key: 'ArrowRight' });
    expect(liveRegion()?.textContent).toBe('Ausgewählter Knoten bewegt sich nach rechts von Position, x: 1.234, y: 5.678');
    expect(handlers.onMove).toHaveBeenCalledTimes(1);
    expect(handlers.onMove).toHaveBeenLastCalledWith('a', { x: 1239, y: 5678 });

    for (const [key, direction] of [['ArrowLeft', 'nach links'], ['ArrowUp', 'nach oben'], ['ArrowDown', 'nach unten']] as const) {
      fireEvent.keyDown(node, { key });
      expect(liveRegion()?.textContent).toMatch(new RegExp(`^Ausgewählter Knoten bewegt sich ${direction} von Position, x: \\d\\.\\d{3}, y: \\d\\.\\d{3}$`));
    }
    expect(liveRegion()?.textContent).not.toContain('Moving selected node');
    expect(handlers.onMove).toHaveBeenCalledTimes(4);
    expect(screen.getByTestId('rf__node-a')).toBe(node);
  });
});
