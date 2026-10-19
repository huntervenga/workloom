import { describe, expect, it } from 'vitest';
import { workspaceSchema } from './workspaces.js';

const oldResponse = { id: '10000000-0000-4000-8000-000000000001', name: 'Remote team', role: 'owner' as const, timezone: 'Asia/Nicosia' };

describe('additive workspace calendar context', () => {
  it('keeps an old response byte-shape without injecting a week start default', () => {
    expect(workspaceSchema.parse(oldResponse)).toEqual(oldResponse);
    expect(workspaceSchema.parse(oldResponse)).not.toHaveProperty('weekStart');
  });
  it('accepts persisted ISO week starts and rejects values outside 1–7', () => {
    for (const weekStart of [1, 2, 7]) expect(workspaceSchema.parse({ ...oldResponse, weekStart }).weekStart).toBe(weekStart);
    for (const weekStart of [0, 8, 1.5, '7', null]) expect(workspaceSchema.safeParse({ ...oldResponse, weekStart }).success).toBe(false);
  });
});
