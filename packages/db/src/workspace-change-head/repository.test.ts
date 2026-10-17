import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { WorkloomExecutor } from '../client.js';
import { workspaces } from '../schema.js';
import { createWorkspaceChangeHeadReadRepository } from './repository.js';

const workspaceId = 'aa000000-0000-4000-8000-000000000001';
function harness(rows: unknown[]) {
  const limit = vi.fn(async () => rows);
  const where = vi.fn((_condition: SQL) => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  const repository = createWorkspaceChangeHeadReadRepository({ select } as unknown as WorkloomExecutor);
  return { repository, select, from, where, limit };
}

describe('workspace change head scalar repository', () => {
  it('selects only head fields from exactly the authorized workspace without locks or bigint conversion', async () => {
    const row = { workspaceId, changeSeq: 9223372036854775807n, permissionEpoch: 9007199254740993n };
    const h = harness([row]); expect(await h.repository.findHead(workspaceId)).toEqual(row);
    expect(h.select).toHaveBeenCalledWith({ workspaceId: workspaces.id, changeSeq: workspaces.changeSeq, permissionEpoch: workspaces.permissionEpoch });
    expect(h.from).toHaveBeenCalledWith(workspaces); expect(h.limit).toHaveBeenCalledWith(1);
    const condition = h.where.mock.calls[0]?.[0]; expect(condition).toBeDefined();
    const query = new PgDialect().sqlToQuery(condition as SQL);
    expect(query.params).toEqual([workspaceId]); expect(query.sql).toBe('"workspaces"."id" = $1');
  });
  it('returns absent when the scoped workspace is missing', async () => {
    expect(await harness([]).repository.findHead(workspaceId)).toBeNull();
  });
});
