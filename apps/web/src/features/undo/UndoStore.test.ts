import { describe, expect, it, vi } from 'vitest';
import { isNativeUndoTarget, UndoStore, type UndoEntry } from './UndoStore';
const scope = 'actor/workspace/project';
function setup() {
  const protect = vi.fn(), blocked = vi.fn(() => false), key = vi.fn(() => 'same-key');
  const store = new UndoStore({ blocked, protect, key, uncertain: error => error === 'unknown' });
  store.activate(scope, true); return { store, protect, blocked, key };
}
function entry(id = 'edit', options: Partial<UndoEntry> = {}): UndoEntry {
  return { id, scope, kind: 'edit', heads: { task: 2 }, beforeHeads: { task: 1 }, prepare: () => async () => ({ task: 3 }), ...options };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
describe('confirmed project undo commands', () => {
  it('records ordinary ACKs silently, deduplicates replay and retains keyboard stack after dismiss', async () => {
    const { store } = setup(); store.record(entry()); store.record(entry());
    expect(store.getSnapshot()).toMatchObject({ count: 1, notice: null }); store.dismiss();
    await store.undo(); expect(store.getSnapshot()).toMatchObject({ count: 0, notice: 'done' });
  });
  it('critical archive offers notification; first-fill clear explicitly preserves history', async () => {
    const { store } = setup(); store.record(entry('archive', { kind: 'archive', clearFirstFill: true }));
    expect(store.getSnapshot()).toMatchObject({ critical: true, notice: 'available' });
    await store.undo(); expect(store.getSnapshot().notice).toBe('cleared');
  });
  it('never sends when readonly, wrong scope, other write or unsent draft is protected', async () => {
    const { store, blocked } = setup(), send = vi.fn(async () => ({}));
    store.record(entry('edit', { prepare: () => send })); blocked.mockReturnValue(true); await store.undo(); expect(send).not.toHaveBeenCalled();
    blocked.mockReturnValue(false); store.activate(scope, false); await store.undo(); expect(send).not.toHaveBeenCalled();
    store.activate('other', true); await store.undo(); expect(send).not.toHaveBeenCalled(); expect(store.getSnapshot().count).toBe(0);
  });
  it('retries unknown inverse with exact prepared body and receipt, blocks new inverse and protects navigation', async () => {
    const { store, protect, key } = setup(), send = vi.fn().mockRejectedValueOnce('unknown').mockResolvedValue({ task: 3 }), prepare = vi.fn(() => send);
    store.record(entry('edit', { prepare })); await store.undo();
    expect(store.getSnapshot().notice).toBe('unknown'); expect(protect).toHaveBeenLastCalledWith(true);
    store.record(entry('later')); await store.undo();
    expect(prepare).toHaveBeenCalledTimes(1); expect(key).toHaveBeenCalledTimes(1); expect(send).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().count).toBe(1); expect(protect).toHaveBeenLastCalledWith(false);
  });
  it('does not lose a late ACK when another inverse is in flight', async () => {
    const { store } = setup(), wait = deferred<{ task: number }>();
    store.record(entry('first', { prepare: () => () => wait.promise }));
    const running = store.undo(); store.record(entry('late', { heads: { other: 7 }, beforeHeads: { other: 6 } })); wait.resolve({ task: 3 }); await running;
    expect(store.getSnapshot().count).toBe(1); await store.undo(); expect(store.getSnapshot().count).toBe(0);
  });
  it('retains unknown exact request across navigation but cannot retry under another project or actor', async () => {
    const { store, protect } = setup(), send = vi.fn().mockRejectedValueOnce('unknown').mockResolvedValue({ task: 3 });
    store.record(entry('first', { prepare: () => send })); await store.undo();
    store.activate('other-actor/workspace/project', true); await store.undo(); expect(send).toHaveBeenCalledTimes(1); expect(protect).toHaveBeenLastCalledWith(true);
    store.activate(scope, true); await store.undo(); expect(send).toHaveBeenCalledTimes(2); expect(protect).toHaveBeenLastCalledWith(false);
  });
  it('keeps a pending inverse protected through scope changes until its answer', async () => {
    const { store, protect } = setup(), wait = deferred<{ task: number }>();
    store.record(entry('first', { prepare: () => () => wait.promise })); const running = store.undo();
    store.activate(null, false); expect(store.hasOutstanding).toBe(true); expect(protect).toHaveBeenLastCalledWith(true);
    wait.resolve({ task: 3 }); await running; expect(protect).toHaveBeenLastCalledWith(false); expect(store.hasOutstanding).toBe(false);
  });
  it('advances an earlier guard only from own exact before-head, never from an unrelated head', async () => {
    const { store } = setup(), earlier = vi.fn(() => async () => ({ task: 5 }));
    store.record(entry('A', { prepare: earlier })); store.record(entry('B', { heads: { task: 3 }, beforeHeads: { task: 2 }, prepare: () => async () => ({ task: 4 }) }));
    await store.undo(); await store.undo(); expect(earlier).toHaveBeenCalledWith({ task: 4 }, 'same-key');
    store.record(entry('C', { heads: { task: 20 }, prepare: earlier })); store.record(entry('D', { heads: { task: 24 }, beforeHeads: { task: 22 }, prepare: () => async () => ({ task: 25 }) }));
    await store.undo(); await store.undo(); expect(earlier).toHaveBeenLastCalledWith({ task: 20 }, 'same-key');
  });
  it('reports a rejected inverse preparation without sending, losing history or leaking a pending slot',async()=>{
    const{store,protect}=setup();store.record(entry('invalid',{prepare:()=>{throw new Error('invalid input');}}));await store.undo();expect(store.getSnapshot()).toMatchObject({count:1,notice:'blocked'});expect(protect).not.toHaveBeenCalledWith(true);
  });
  it('a rejected inverse leaves the stack intact and does not send an earlier action', async () => {
    const { store, protect } = setup(), send = vi.fn().mockRejectedValue(new Error('conflict'));
    store.record(entry('A')); store.record(entry('B', { prepare: () => send })); await store.undo();
    expect(store.getSnapshot()).toMatchObject({ count: 2, notice: 'blocked' }); expect(protect).toHaveBeenLastCalledWith(false);
  });
  it('unsupported actions are an explicit keyboard boundary, not a silent skip', async () => {
    const { store } = setup(); store.record(entry('A')); store.record(entry('B', { kind: 'unsupported', prepare: undefined })); await store.undo();
    expect(store.getSnapshot()).toMatchObject({ count: 2, notice: 'unsupported' });
  });
  it('treats unhandled ACKs as silent scope-bound barriers and consumes only accepted supported receipts', async () => {
    const { store } = setup(), send=vi.fn(async()=>({task:3}));
    store.record(entry('A',{receipt:'supported',prepare:()=>send})); store.acknowledge('supported','workspace','actor'); expect(store.getSnapshot().count).toBe(1);
    store.acknowledge('wrong actor','workspace','other'); store.acknowledge('wrong workspace','other','actor'); store.acknowledge('unknown actor','workspace',null); expect(store.getSnapshot().count).toBe(1);
    store.acknowledge('schedule ACK','workspace','actor'); expect(store.getSnapshot()).toMatchObject({count:2,notice:null}); await store.undo();expect(store.getSnapshot().notice).toBe('unsupported');expect(send).not.toHaveBeenCalled();
    store.activate('actor/workspace/linked',true);store.record(entry('canonical',{receipt:'linked-ACK'}));store.acknowledge('linked-ACK','workspace','actor');expect(store.getSnapshot().count).toBe(1);await store.undo();expect(store.getSnapshot().notice).toBe('unsupported');
  });
  it('records acknowledged changes and unsupported boundaries while temporarily readonly',async()=>{
    const{store}=setup(),send=vi.fn(async()=>({task:3}));store.record(entry('earlier',{prepare:()=>send}));
    store.setWritable(false);store.record(entry('later',{heads:{other:2},beforeHeads:{other:1}}));expect(store.getSnapshot().count).toBe(2);await store.undo();expect(send).not.toHaveBeenCalled();
    store.acknowledge('unsupported while readonly','workspace','actor');store.setWritable(true);await store.undo();expect(store.getSnapshot()).toMatchObject({count:3,notice:'unsupported'});expect(send).not.toHaveBeenCalled();
  });
  it('a throwing configured recorder forces a boundary even after it marked its receipt handled',async()=>{
    const{store}=setup();store.record(entry('supported',{receipt:'same'}));store.acknowledge('same','workspace','actor',true);await store.undo();expect(store.getSnapshot()).toMatchObject({count:2,notice:'unsupported'});
  });
  it('leaves native typing undo to editable inputs and contenteditable descendants', () => {
    for (const html of ['<input>', '<textarea></textarea>', '<div contenteditable="true"><span>typing</span></div>', '<div role="textbox"><span>typing</span></div>']) {
      const wrap = document.createElement('div'); wrap.innerHTML = html; expect(isNativeUndoTarget(wrap.querySelector('span') ?? wrap.firstElementChild)).toBe(true);
    }
    expect(isNativeUndoTarget(document.createElement('button'))).toBe(false);
  });
});
