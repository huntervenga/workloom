import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { expect, type APIRequestContext } from '@playwright/test';
import { membershipSchema, projectSchema, tagResponseSchema, tagSchema, taskListResponseSchema, taskStatusSchema } from '@workloom/contracts';
import { z } from 'zod';
import { dailyFixture } from './daily-fixture.js';

const fixtureSchema = z.object({ stage: z.literal('complete'), version: z.literal(1), origin: z.string().url(),
  workspaceId: z.literal('5eed0000-0000-4000-8000-000000000201'), project: projectSchema,
  own: membershipSchema, other: membershipSchema, todo: taskStatusSchema, progress: taskStatusSchema,
  tag: tagSchema, token: z.string(), titles: z.array(z.string()).length(97), allTitles: z.array(z.string()).length(101) });
export type BoardPaginationFixture = z.infer<typeof fixtureSchema>;
let shared: Promise<BoardPaginationFixture> | undefined;

/** One additive, read-only-after-creation fixture survives worker restarts across both sizes. */
export function boardPaginationFixture(request: APIRequestContext, baseURL: string | undefined) {
  shared ??= prepare(request, baseURL); return shared;
}
async function prepare(request: APIRequestContext, baseURL: string | undefined): Promise<BoardPaginationFixture> {
  if (!baseURL) throw new Error('Live browser origin required.');
  const key = process.env.WORKLOOM_BOARD_FIXTURE_KEY ?? 'cycle20261016-v3';
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(key)) throw new Error('Explicit safe QA fixture key required.');
  const manifest = resolve('.local/qa', `board-pagination-${key}.json`), origin = new URL(baseURL).origin;
  let existing: string | undefined;
  try { existing = await readFile(manifest, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (existing !== undefined) {
    const stored = fixtureSchema.parse(JSON.parse(existing));
    if (stored.origin !== origin) throw new Error('QA fixture origin changed. Review its manifest rather than creating a second fixture.');
    return stored;
  }
  await mkdir(dirname(manifest), { recursive: true, mode: 0o700 });
  const save = async (value: unknown) => { const temporary = `${manifest}.${randomUUID()}.pending`; await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' }); await rename(temporary, manifest); };
  // An interrupted setup is retained and fails closed on the next parse, not silently reseeded.
  await save({ stage: 'starting', version: 1, origin, startedAt: new Date().toISOString() });
  const f = await dailyFixture(request, baseURL, 'Board pagination read-only QA');
  await save({ stage: 'creating-tasks', version: 1, origin, workspaceId: f.workspace.id, projectId: f.project.id });
  const tag = (await f.post('/tags', { name: `Board pagination ${f.token}`, color: null }, tagResponseSchema)).data;
  const token = `Board page ${f.token}`, titles: string[] = [], allTitles: string[] = [];
  for (let index = 0; index < 97; index++) { const title = `${token} ${String(index + 1).padStart(3, '0')}`; await f.createTask(title, { tagIds: [tag.id] }); titles.push(title); allTitles.push(title); }
  allTitles.push((await f.createTask(`${token} untagged`)).title);
  allTitles.push((await f.createTask(`${token} other status`, { statusId: f.progress.id, tagIds: [tag.id] })).title);
  allTitles.push((await f.createTask(`${token} other participant`, { responsibleMembershipId: f.other.id, participantMembershipIds: [f.other.id], tagIds: [tag.id] })).title);
  allTitles.push((await f.createTask(`Outside search ${f.token}`, { tagIds: [tag.id] })).title);
  const fixture = fixtureSchema.parse({ stage: 'complete', version: 1, origin, workspaceId: f.workspace.id, project: f.project, own: f.own, other: f.other, todo: f.todo, progress: f.progress, tag, token, titles, allTitles });
  // Real server default page size and opaque cursor are checked before making this fixture reusable.
  const prefix = `/api/v1/workspaces/${fixture.workspaceId}`;
  const query = new URLSearchParams({ projectId: fixture.project.id, limit: '100' });
  const response = await request.get(`${prefix}/tasks?${query}`); expect(response.status()).toBe(200); const first = taskListResponseSchema.parse(await response.json()); expect(first.data).toHaveLength(100); expect(first.meta.nextCursor).toBeTruthy();
  query.set('cursor', first.meta.nextCursor ?? ''); const next = await request.get(`${prefix}/tasks?${query}`); expect(next.status()).toBe(200); const last = taskListResponseSchema.parse(await next.json()); expect(last.data).toHaveLength(1); expect(last.meta.nextCursor).toBe(null); expect([...first.data, ...last.data].map(task => task.title).sort()).toEqual([...allTitles].sort());
  await save(fixture); return fixture;
}
