import { describe, expect, it } from 'vitest';
import { ProtectedCommandRegistry } from './protectedCommands';

describe('protected command ownership exclusion', () => {
  it('excludes exactly its actual own active slot and still reports every other slot', () => {
    const registry = new ProtectedCommandRegistry(), own = registry.register(), other = registry.register(), observer = registry.register();
    own.set(true);
    expect(registry.protecting).toBe(true); expect(own.hasOthers()).toBe(false); expect(observer.hasOthers()).toBe(true);
    other.set(true);
    expect(own.hasOthers()).toBe(true); expect(other.hasOthers()).toBe(true);
    own.set(false);
    expect(own.hasOthers()).toBe(true); expect(other.hasOthers()).toBe(false);
    other.dispose(); expect(registry.protecting).toBe(false); expect(own.hasOthers()).toBe(false);
  });

  it('cannot exclude a new slot by reusing a disposed or cleared entry', () => {
    const registry = new ProtectedCommandRegistry(), old = registry.register(); old.set(true); old.dispose();
    const live = registry.register(); live.set(true); old.set(true);
    expect(old.hasOthers()).toBe(true); expect(live.hasOthers()).toBe(false);
    registry.clear(); const next = registry.register(); next.set(true); live.set(true);
    expect(live.hasOthers()).toBe(true); expect(next.hasOthers()).toBe(false); expect(registry.protecting).toBe(true);
  });

  it('keeps the existing global protection notifications and departure guard unchanged', async () => {
    const registry = new ProtectedCommandRegistry(), a = registry.register(), b = registry.register(), changes: boolean[] = [];
    const stop = registry.subscribe(() => changes.push(registry.protecting)); let asked = 0;
    registry.setConfirmer(async () => { asked++; return false; });
    a.set(true); b.set(true); a.set(false);
    expect(changes).toEqual([true]); expect(a.hasOthers()).toBe(true);
    expect(await registry.confirmDeparture()).toBe(false); expect(asked).toBe(1);
    b.dispose(); expect(changes).toEqual([true, false]); expect(await registry.confirmDeparture()).toBe(true); expect(asked).toBe(1); stop();
  });
});
