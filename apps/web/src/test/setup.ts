import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { taskAutoLoad } from '../features/tasks/autoLoad';

// Condition-based waits return as soon as they pass; explicit timing oracles and
// physical Chrome acceptance remain separate.
configure({ asyncUtilTimeout: 3_000 });

// Most page tests drive the "Load more tasks" button themselves; the auto-load tests turn this back on.
beforeEach(() => { taskAutoLoad.enabled = false; });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // Each testcase represents a separate browser; reloads inside one case retain preferences.
  try { window.localStorage.clear(); } catch { /* A testcase can deliberately disable storage. */ }
});

// jsdom lacks a few layout APIs that Radix primitives touch.
class ResizeObserverStub {
  observe(): void {
    // no layout in jsdom
  }
  unobserve(): void {
    // no layout in jsdom
  }
  disconnect(): void {
    // no layout in jsdom
  }
}

globalThis.ResizeObserver ??= ResizeObserverStub;
if (typeof Element !== 'undefined') {
  Element.prototype.scrollIntoView ??= () => undefined;
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => undefined;
}
