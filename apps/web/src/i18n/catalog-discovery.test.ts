import { describe, expect, it, vi } from 'vitest';
import { localization } from './index';
import { catalogMessages, type TranslationCatalog } from './LocalizationManager';

const english = import.meta.glob<TranslationCatalog>('./locales/en/*.json', { eager: true, import: 'default' });

// Compare directory-discovered production resources against the actual application manager.
// Test-only locale fixtures never supply or overwrite application English namespaces.
describe('production English JSON discovery', () => {
  it('registers every production namespace and message without a special fallback map', () => {
    const diagnostics = vi.spyOn(console, 'error');
    localization.setLocale('en');
    try {
      expect(Object.keys(english).length).toBeGreaterThan(0);
      for (const [path, catalog] of Object.entries(english)) {
        const namespace = path.slice(path.lastIndexOf('/') + 1, -'.json'.length);
        for (const [key, value] of catalogMessages(catalog, namespace)) {
          const variants = typeof value === 'string' ? [value] : Object.values(value) as string[];
          const parameters: Record<string, string | number> = { count: 2 };
          for (const variant of variants) for (const match of variant.matchAll(/{{\s*([A-Za-z][\w]*)\s*}}/g)) {
            const name = match[1] as string;
            if (name !== 'count') parameters[name] = 'Synthetic catalog value';
          }
          const translated = localization.t(key as `${string}.${string}`, parameters);
          expect(translated, key).not.toContain(`⟦${key}`);
          expect(translated, key).not.toMatch(/{{|}}/);
        }
      }
      expect(diagnostics).not.toHaveBeenCalled();
    } finally { diagnostics.mockRestore(); }
  });
});
