import { readFileSync } from 'node:fs';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import ganttViewSource from '../src/features/schedule/GanttView.tsx?raw';
import { describe, expect, it } from 'vitest';
import { graphNodeBoxStyle } from '../src/features/dependencies/GraphNodeContent';
import { graphEdgeColor, graphEdgeStyle, graphNodeTone } from '../src/features/dependencies/graphPresentation';
import { connectorStyles } from '../src/features/schedule/GanttConnectors';

// The test CSS stub turns `.css?raw` imports into empty strings, so the real files are read from disk.
const readSource = (path: string) => readFileSync(fileURLToPath(new NodeURL(path, import.meta.url)), 'utf8');
const sharedCss = readSource('../../../packages/ui/src/styles.css');
const landingCss = readSource('../src/landing/landing.css');

/*
 * Static checks on the token sources. The contrast ratios are computed from the declared hex values
 * with the WCAG relative-luminance formula; they guard the palette, not rendered pixels.
 */

function tokens(block: string): Record<string, string> {
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map(match => [match[1], (match[2] as string).toLowerCase()]));
}

const lightBlocks = [...sharedCss.matchAll(/@theme(?: static)? \{([\s\S]*?)\n\}/g)].map(match => match[1] ?? '');
const light = tokens(lightBlocks.join('\n'));
const darkBlock = /:root\[data-theme="dark"\] \{([\s\S]*?)\n {2}\}/.exec(sharedCss)?.[1] ?? '';
const dark = tokens(darkBlock);

function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}
function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

const WHITE = '#ffffff';

describe('shared theme tokens', () => {
  it('keeps every original light token value except the accent, darkened so white text on it reaches 4.5:1, and muted, darkened so it reaches 4.5:1 on selection', () => {
    expect(light).toMatchObject({
      'color-canvas': '#f8fafc', 'color-surface': '#ffffff', 'color-ink': '#0f172a', 'color-ink-soft': '#334155',
      'color-muted': '#566477', 'color-subtle': '#94a3b8', 'color-line': '#e2e8f0', 'color-line-strong': '#cbd5e1',
      'color-accent': '#5b5ee0', 'color-accent-strong': '#4f46e5', 'color-accent-ink': '#4338ca', 'color-accent-soft': '#eef2ff', 'color-accent-line': '#c7d2fe',
    });
    expect(sharedCss).toContain('--font-sans: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;');
  });

  it('defines an opaque dark value for every light color token', () => {
    expect(darkBlock).not.toBe('');
    for (const name of Object.keys(light)) expect({ name, value: dark[name] }).toEqual({ name, value: expect.stringMatching(/^#[0-9a-f]{6}$/) });
    expect(darkBlock).toContain('color-scheme: dark;');
  });

  it('pins the selection and chart contracts other features rely on', () => {
    expect([light['color-selection'], dark['color-selection']]).toEqual(['#e0e7ff', '#303a66']);
    expect([light['color-chart-plan'], dark['color-chart-plan']]).toEqual(['#6366f1', '#a5b4fc']);
    expect([light['color-chart-fact'], dark['color-chart-fact']]).toEqual(['#0d9488', '#5eead4']);
    expect([light['color-chart-track'], dark['color-chart-track']]).toEqual(['#f1f5f9', '#263247']);
    expect([light['color-chart-missing'], dark['color-chart-missing']]).toEqual(['#94a3b8', '#94a3b8']);
    for (const name of ['color-surface-hover', 'color-tag-surface', 'color-tag-ink', 'color-focus']) {
      expect(light[name]).toBeDefined();
      expect(dark[name]).toBeDefined();
    }
  });

  it('keeps text, focus and selection distinguishable in both palettes', () => {
    for (const palette of [light, dark]) {
      const p = (name: string) => palette[`color-${name}`] as string;
      expect(contrast(p('ink'), p('canvas'))).toBeGreaterThanOrEqual(7);
      expect(contrast(p('ink'), p('surface'))).toBeGreaterThanOrEqual(7);
      expect(contrast(p('ink-soft'), p('surface'))).toBeGreaterThanOrEqual(7);
      expect(contrast(p('muted'), p('surface'))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p('accent-ink'), p('accent-soft'))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p('accent-ink'), p('surface'))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(WHITE, p('accent'))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(WHITE, p('accent-strong'))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p('focus'), p('canvas'))).toBeGreaterThanOrEqual(3);
      expect(contrast(p('focus'), p('surface'))).toBeGreaterThanOrEqual(3);
      expect(contrast(p('ink'), p('selection'))).toBeGreaterThanOrEqual(7);
      expect(contrast(p('selection'), p('surface'))).toBeGreaterThanOrEqual(1.2);
      expect(contrast(p('line'), p('surface'))).toBeGreaterThanOrEqual(1.2);
      expect(contrast(p('tag-ink'), p('tag-surface'))).toBeGreaterThanOrEqual(4.5);
      for (const series of ['chart-plan', 'chart-fact']) expect(contrast(p(series), p('chart-track'))).toBeGreaterThanOrEqual(3);
      for (const stroke of ['graph-edge-unresolved', 'graph-edge-resolved']) expect(contrast(p(stroke), p('surface'))).toBeGreaterThanOrEqual(3);
      for (const stroke of ['gantt-compatible', 'gantt-conflict']) expect(contrast(p(stroke), p('gantt-weekend'))).toBeGreaterThanOrEqual(3);
    }
    for (const line of ['success-line', 'danger-line', 'warning-line']) expect(contrast(dark[`color-${line}`] as string, dark['color-surface'] as string)).toBeGreaterThanOrEqual(3);
  });

  it('keeps muted secondary text readable on every surface it sits on, below ink-soft, in both palettes', () => {
    for (const [paletteName, palette] of [['light', light], ['dark', dark]] as const) {
      const p = (name: string) => palette[`color-${name}`] as string;
      // Completed titles and secondary row text use muted, including on selected and hovered rows.
      for (const background of ['canvas', 'surface', 'surface-hover', 'selection', 'tag-surface']) {
        const ratio = contrast(p('muted'), p(background));
        expect({ palette: paletteName, background, muted: p('muted'), on: p(background), ratio, ok: ratio >= 4.5 })
          .toEqual({ palette: paletteName, background, muted: p('muted'), on: p(background), ratio, ok: true });
      }
      expect({ palette: paletteName, inkOverInkSoft: contrast(p('ink'), p('surface')) > contrast(p('ink-soft'), p('surface')) }).toEqual({ palette: paletteName, inkOverInkSoft: true });
      expect({ palette: paletteName, inkSoftOverMuted: contrast(p('ink-soft'), p('surface')) > contrast(p('muted'), p('surface')) }).toEqual({ palette: paletteName, inkSoftOverMuted: true });
      expect({ palette: paletteName, mutedDistinctFromSubtle: p('muted') !== p('subtle') }).toEqual({ palette: paletteName, mutedDistinctFromSubtle: true });
    }
  });

  it('maps the used Tailwind palette steps to readable dark roles without inverting fills under white text', () => {
    const d = (name: string) => dark[`color-${name}`] as string;
    const surface = d('surface');
    for (const [text, background] of [
      ['amber-800', 'amber-50'], ['amber-900', 'amber-100'], ['amber-700', 'surface'], ['emerald-800', 'emerald-50'], ['emerald-700', 'emerald-100'],
      ['indigo-700', 'indigo-50'], ['indigo-900', 'indigo-100'], ['red-700', 'red-50'], ['red-800', 'red-50'], ['red-600', 'surface'],
      ['rose-700', 'rose-100'], ['sky-700', 'sky-100'], ['teal-700', 'teal-100'], ['violet-700', 'violet-100'], ['orange-800', 'surface'],
      ['slate-600', 'surface'], ['slate-700', 'slate-100'], ['ink', 'slate-200'],
    ] as const) {
      expect({ text, background, ok: contrast(d(text), background === 'surface' ? surface : d(background)) >= 4.5 }).toEqual({ text, background, ok: true });
    }
    // Fills that carry white icons or text keep Tailwind's own value.
    for (const fill of ['emerald-500', 'emerald-600', 'indigo-500', 'rose-500', 'slate-900']) expect(dark[`color-${fill}`]).toBeUndefined();
    const emeraldText = /\.text-emerald-600 \{\s*color: (#[0-9a-f]{6});/.exec(sharedCss)?.[1] ?? '';
    expect(contrast(emeraldText, surface)).toBeGreaterThanOrEqual(4.5);
    expect(sharedCss).not.toMatch(/filter|invert\(/);
    expect(darkBlock).not.toContain('!important');
    expect(sharedCss).not.toMatch(/\.text-white/);
  });

  it('defines every theme variable the graph and Gantt views reference, in both palettes', () => {
    const values = [
      graphEdgeColor('unresolved'), graphEdgeColor('resolved'),
      graphEdgeStyle('resolved', 'focused').stroke,
      ...[{ violatesCurrentStatus: true }, { blocked: true }, { statusGroup: 'done' as const }, {}].flatMap(task => Object.values(graphNodeTone({ id: 'x', blocked: false, ...task }, 'focused'))),
      graphNodeBoxStyle.borderColor, graphNodeBoxStyle.background,
      connectorStyles.compatible.stroke, connectorStyles.conflict.stroke,
      /const TRACK_BACKGROUND = '([^']+)'/.exec(ganttViewSource)?.[1],
    ].map(String).join(' ');
    const names = [...new Set([...values.matchAll(/var\(--([\w-]+)\)/g)].map(match => match[1] as string).filter(name => name.startsWith('color-')))];
    expect(names.length).toBeGreaterThanOrEqual(12);
    expect(values).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
    for (const name of names) expect({ name, light: light[name] !== undefined, dark: dark[name] !== undefined }).toEqual({ name, light: true, dark: true });
  });
});

describe('landing palette', () => {
  const darkLanding = /:root\[data-theme="dark"\] \.landing \{([\s\S]*?)\n\}/.exec(landingCss)?.[1] ?? '';
  const defined = new Set([...darkLanding.matchAll(/--(landing-[\w-]+):/g)].map(match => match[1]));
  const uses = [...landingCss.matchAll(/var\(--(landing-[\w-]+)(?:,\s*([^)]+))?\)/g)].map(match => ({ name: match[1] as string, fallback: match[2]?.trim() }));
  const darkValue = (name: string) => new RegExp(`--${name}:(#[0-9a-f]{6})`).exec(darkLanding)?.[1] as string;

  it('keeps the original light look by giving every role its original value as the fallback', () => {
    expect(uses.length).toBeGreaterThan(30);
    for (const use of uses) expect({ name: use.name, fallback: use.fallback }).toEqual({ name: use.name, fallback: expect.stringMatching(/^(#[0-9a-f]{3,8}|white)$/) });
    expect(landingCss).toContain('background:var(--landing-bg, #faf9fd); color:var(--landing-ink, #252036);');
    expect(landingCss).toContain('.landing .button-primary { background:#7350c5; color:white;');
  });

  it('defines exactly the used roles for dark, with readable text', () => {
    expect([...defined].sort()).toEqual([...new Set(uses.map(use => use.name))].sort());
    for (const surface of ['landing-bg', 'landing-surface', 'landing-chip']) {
      expect(contrast(darkValue('landing-ink'), darkValue(surface))).toBeGreaterThanOrEqual(7);
      expect(contrast(darkValue('landing-muted'), darkValue(surface))).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(darkValue('landing-eyebrow'), darkValue('landing-bg'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(darkValue('landing-chip-active-ink'), darkValue('landing-chip-active'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(darkValue('landing-focus'), darkValue('landing-bg'))).toBeGreaterThanOrEqual(3);
    expect(landingCss).not.toMatch(/filter|invert\(/);
  });
});
