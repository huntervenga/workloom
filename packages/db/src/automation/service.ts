import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import {
  publicTaskCreateSchema, publicTaskListQuerySchema, publicTaskUpdateSchema, taskViewSchema, updateTaskInputSchema,
  type ApiTokenDto, type ApiTokenScope, type CreateApiTokenInput, type CreatedApiTokenDto, type PublicMeDto, type PublicMemberDto,
  type PublicProjectDetailDto, type PublicProjectDto, type PublicTagDto, type PublicTaskCreate, type PublicTaskListQuery, type PublicTaskUpdate,
  type PublicWorkspaceDto, type TaskView, type UpdateTaskInput, type TaskDto,
} from '@workloom/contracts';
import { authorizeWorkspace, capabilityRequiredError, DomainError, isDomainError, listWorkspaceMembers, notFoundError, type Capability, type CommandContext } from '@workloom/domain';
import { isDatabase, type Database, type WorkloomExecutor } from '../client.js';
import { createAccessRepository } from '../repositories/access-repository.js';
import { createTaskRepository } from '../repositories/task-repository.js';
import { createTaskApplication } from '../tasks/task-application.js';
import { createWorkspaceWriteRunner } from '../transactions/workspace-write.js';
import { workspaceSlugAliases, workspaces, memberships } from '../schema.js';
import { isUuid, matchRefs, resolveRef, resolveRefs } from './refs.js';
import { databaseNow, issueApiToken, listApiTokens, loadPrincipal, parseApiToken, revokeApiToken, type ApiPrincipal } from './tokens.js';
import { listTaskViews, loadTaskView, type ResolvedTaskFilter } from './view.js';

export interface WriteOptions {
  readonly requestId: string;
  /** Caller-held key making a retry of the same write safe; without it each call is a distinct write. */
  readonly idempotencyKey?: string | undefined;
}
export interface AutomationApplicationOptions { readonly cursorSecret?: string; readonly lockTimeoutMs?: number; readonly statementTimeoutMs?: number }

/** The one core behind the public REST API and the remote MCP tools. Every method takes the bearer token. */
export interface AutomationApplication {
  issueToken(userId: string, input: CreateApiTokenInput): Promise<CreatedApiTokenDto>;
  listTokens(userId: string): Promise<ApiTokenDto[]>;
  revokeToken(userId: string, tokenId: string): Promise<ApiTokenDto>;
  me(token: string): Promise<PublicMeDto>;
  /** Scopes the token carries; used by transports to decide which MCP tools to list. */
  describeToken(token: string): Promise<{ scopes: readonly ApiTokenScope[] }>;
  listWorkspaces(token: string): Promise<PublicWorkspaceDto[]>;
  listProjects(token: string, workspace: string | undefined): Promise<PublicProjectDto[]>;
  getProject(token: string, workspace: string | undefined, project: string): Promise<PublicProjectDetailDto>;
  listMembers(token: string, workspace: string | undefined): Promise<PublicMemberDto[]>;
  listTags(token: string, workspace: string | undefined): Promise<PublicTagDto[]>;
  listTasks(token: string, workspace: string | undefined, query: PublicTaskListQuery): Promise<{ items: TaskView[]; nextCursor: string | null }>;
  getTask(token: string, workspace: string | undefined, taskId: string): Promise<TaskView>;
  createTask(token: string, workspace: string | undefined, input: PublicTaskCreate, options: WriteOptions): Promise<TaskView>;
  updateTask(token: string, workspace: string | undefined, taskId: string, input: PublicTaskUpdate, options: WriteOptions): Promise<TaskView>;
}

interface ReadScope {
  readonly tx: WorkloomExecutor;
  readonly principal: ApiPrincipal;
  readonly workspaceId: string;
  readonly context: CommandContext;
  readonly role: string;
  readonly myMembershipId: string;
}

const KEY = /^[\x21-\x7e]{1,128}$/;
const READ_CAPABILITY: Capability = 'task.read';

export function createAutomationApplication(source: Database | WorkloomExecutor, options: AutomationApplicationOptions = {}): AutomationApplication {
  const db = isDatabase(source) ? source.db : source;
  const cursorSecret = options.cursorSecret ?? randomBytes(32).toString('hex');
  const bound = (tx: WorkloomExecutor) => tx.execute(sql`select set_config('lock_timeout','5000ms',true),set_config('statement_timeout','15000ms',true)`);

  function requireScope(principal: ApiPrincipal, scope: ApiTokenScope): void {
    if (!principal.scopes.includes(scope)) throw capabilityRequiredError();
  }

  async function touch(principal: ApiPrincipal): Promise<void> {
    // Best effort and rate limited to once a minute; never part of the caller's transaction.
    try {
      await db.execute(sql`update api_tokens set last_used_at = now() where id = ${principal.tokenId} and (last_used_at is null or last_used_at < now() - interval '1 minute')`);
    } catch { /* usage bookkeeping must not fail a request */ }
  }

  /** Resolves a workspace by UUID or slug (current or former), then proves the caller is an active member. */
  async function findWorkspaceId(tx: WorkloomExecutor, principal: ApiPrincipal, ref: string): Promise<string> {
    let id: string | undefined;
    if (isUuid(ref)) id = ref.toLowerCase();
    else {
      const slug = ref.toLowerCase();
      const [current] = await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.slug, slug)).limit(1);
      if (current) id = current.id;
      else {
        const [alias] = await tx.select({ id: workspaceSlugAliases.workspaceId }).from(workspaceSlugAliases).where(eq(workspaceSlugAliases.slug, slug)).limit(1);
        id = alias?.id;
      }
    }
    // Unknown, forbidden and unreachable workspaces are indistinguishable.
    if (!id || (principal.workspaceIds !== null && !principal.workspaceIds.includes(id))) throw notFoundError();
    return id;
  }

  async function accessibleWorkspaces(tx: WorkloomExecutor, principal: ApiPrincipal): Promise<PublicWorkspaceDto[]> {
    const rows = await tx.select({ id: workspaces.id, slug: workspaces.slug, name: workspaces.name, timezone: workspaces.timezone, role: memberships.role })
      .from(memberships).innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
      .where(and(eq(memberships.userId, principal.userId), eq(memberships.state, 'active')));
    return rows.filter(row => principal.workspaceIds === null || principal.workspaceIds.includes(row.id))
      .map(row => ({ id: row.id, slug: row.slug, name: row.name, timezone: row.timezone, role: row.role }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async function defaultWorkspace(tx: WorkloomExecutor, principal: ApiPrincipal): Promise<string> {
    const list = await accessibleWorkspaces(tx, principal);
    if (list.length === 1 && list[0]) return list[0].id;
    const names = list.map(item => item.slug ?? item.id).join(', ');
    throw new DomainError('VALIDATION_FAILED', list.length === 0 ? 'This token has no accessible workspace.' : `Choose a workspace (${names}).`, { details: { field: 'workspace', reason: 'required', candidates: list.map(item => ({ id: item.id, name: item.name, slug: item.slug })) } });
  }

  /** One repeatable-read snapshot: token validity, scope, membership, capability and data are read together. */
  async function authorizedRead<T>(token: string, scope: ApiTokenScope, workspace: string | undefined | null, capability: Capability, work: (scope: ReadScope) => Promise<T>): Promise<T> {
    const hash = parseApiToken(token);
    let seen: ApiPrincipal | undefined;
    const result = await db.transaction(async tx => {
      await bound(tx);
      const principal = await loadPrincipal(tx, hash, await databaseNow(tx));
      seen = principal;
      requireScope(principal, scope);
      const workspaceId = workspace === null ? '' : workspace === undefined ? await defaultWorkspace(tx, principal) : await findWorkspaceId(tx, principal, workspace);
      const context: CommandContext = { actor: { userId: principal.userId, displayName: principal.displayName, kind: principal.kind }, workspaceId, source: 'api', requestId: 'pending' };
      let role = 'member', myMembershipId = '';
      if (workspace !== null) {
        const access = await authorizeWorkspace(createAccessRepository(tx), context, capability);
        role = access.membership.role; myMembershipId = access.membership.id;
      }
      return work({ tx, principal, workspaceId, context, role, myMembershipId });
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
    if (seen) void touch(seen);
    return result;
  }

  const taskApp = (tx: WorkloomExecutor) => createTaskApplication(tx, { cursorSecret });

  async function projectItems(s: ReadScope) {
    return (await taskApp(s.tx).listProjects(s.context)).map(project => ({ id: project.id, name: project.name, archived: project.archivedAt !== null }));
  }
  async function membersOf(s: ReadScope) {
    return (await listWorkspaceMembers(createAccessRepository(s.tx), s.context)).map(member => ({ id: member.id, name: member.displayName, userId: member.userId, role: member.role }));
  }

  /** Assignee references: `me`, a membership id, a user id or an exact display name. */
  function resolvePerson(s: ReadScope, value: string, people: readonly { id: string; name: string; userId: string }[], field = 'assignee') {
    if (value.toLowerCase() === 'me') return s.myMembershipId;
    if (isUuid(value)) { const byUser = people.find(person => person.userId.toLowerCase() === value.toLowerCase()); if (byUser) return byUser.id; }
    return resolveRef(field, value, people).id;
  }

  /** Maps friendly references to the ids the domain command expects, inside the caller's authorized snapshot. */
  async function buildCreateInput(s: ReadScope, input: PublicTaskCreate) {
    const app = taskApp(s.tx);
    const project = resolveRef('project', input.project, await projectItems(s));
    const people = await membersOf(s);
    const [sectionRows, statusRows, tagRows] = await Promise.all([app.listSections(s.context, project.id), app.listStatuses(s.context, project.id), input.tags?.length ? app.listTags(s.context) : Promise.resolve([])]);
    const configured = (await createTaskRepository(s.tx).findTaskDefaults?.(s.workspaceId, project.id))?.config.statusId ?? null;
    const ordered = [...statusRows].sort((a, b) => a.position - b.position);
    // An explicit status wins; then the project's default; then the first "to do" status.
    const status = input.status !== undefined
      ? resolveRef('status', input.status, statusRows)
      : ordered.find(row => row.id === configured) ?? ordered.find(row => row.group === 'todo') ?? ordered[0];
    if (!status) throw new DomainError('VALIDATION_FAILED', 'The project has no statuses.');
    return {
      projectId: project.id, title: input.title,
      ...(input.description !== undefined ? { description: input.description } : {}),
      statusId: status.id,
      ...(input.section !== undefined ? { sectionId: input.section === null ? null : resolveRef('section', input.section, sectionRows.filter(row => row.archivedAt === null)).id } : {}),
      ...(input.assignee !== undefined ? { responsibleMembershipId: input.assignee === null || input.assignee.toLowerCase() === 'none' ? null : resolvePerson(s, input.assignee, people) } : {}),
      ...(input.participants !== undefined ? { participantMembershipIds: [...new Set(input.participants.map(value => resolvePerson(s, value, people, 'participant')))] } : {}),
      ...(input.startDate !== undefined ? { startDate: input.startDate } : {}),
      ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.tags !== undefined ? { tagIds: resolveRefs('tag', input.tags, tagRows.filter(row => row.archivedAt === null)).map(tag => tag.id) } : {}),
      ...(input.estimateMinutes !== undefined ? { estimateMinutes: input.estimateMinutes } : {}),
      ...(input.parentTask !== undefined ? { parentTaskId: input.parentTask } : {}),
    };
  }

  async function writeContext(s: ReadScope, options: WriteOptions): Promise<CommandContext> {
    if (options.idempotencyKey !== undefined && !KEY.test(options.idempotencyKey)) throw new DomainError('VALIDATION_FAILED', 'Idempotency-Key must be 1–128 printable ASCII characters.');
    return { ...s.context, requestId: options.requestId, idempotencyKey: options.idempotencyKey ?? `pub-${randomUUID()}` };
  }

  /** Revalidates the token under the workspace barrier, so a revoke committed earlier always wins. */
  function writeApp(hash: string, workspaceId: string, userId: string) {
    return createTaskApplication(source, {
      ...options, cursorSecret,
      authorizeInScope: async scope => {
        const principal = await loadPrincipal(scope.tx, hash, scope.barrierAt, true);
        requireScope(principal, 'tasks:write');
        if (principal.userId !== userId || scope.context.workspaceId !== workspaceId || (principal.workspaceIds !== null && !principal.workspaceIds.includes(workspaceId))) throw notFoundError();
        return { apiTokenId: principal.tokenId };
      },
    });
  }

  async function prepared<T>(token: string, workspace: string | undefined, work: (s: ReadScope, hash: string) => Promise<T>): Promise<T> {
    const hash = parseApiToken(token);
    return authorizedRead(token, 'tasks:write', workspace, 'task.edit', s => work(s, hash));
  }

  return {
    issueToken: (userId, input) => db.transaction(tx => issueApiToken(tx, userId, input)),
    listTokens: userId => db.transaction(tx => listApiTokens(tx, userId), { accessMode: 'read only' }),
    revokeToken: (userId, tokenId) => db.transaction(tx => revokeApiToken(tx, userId, tokenId)),

    describeToken: token => authorizedRead(token, 'read', null, 'workspace.read', async s => ({ scopes: s.principal.scopes })),

    me: token => authorizedRead(token, 'read', null, 'workspace.read', async s => ({
      user: { id: s.principal.userId, displayName: s.principal.displayName },
      token: { id: s.principal.tokenId, name: s.principal.tokenName, scopes: [...s.principal.scopes], expiresAt: s.principal.expiresAt.toISOString() },
      workspaces: await accessibleWorkspaces(s.tx, s.principal),
    })),

    listWorkspaces: token => authorizedRead(token, 'read', null, 'workspace.read', s => accessibleWorkspaces(s.tx, s.principal)),

    listProjects: (token, workspace) => authorizedRead(token, 'read', workspace, READ_CAPABILITY, s => projectItems(s)),

    getProject: (token, workspace, project) => authorizedRead(token, 'read', workspace, READ_CAPABILITY, async s => {
      const found = resolveRef('project', project, await projectItems(s));
      const app = taskApp(s.tx);
      const [sectionRows, statusRows] = await Promise.all([app.listSections(s.context, found.id), app.listStatuses(s.context, found.id)]);
      return {
        ...found,
        sections: sectionRows.filter(row => row.archivedAt === null).sort((a, b) => a.position - b.position).map(row => ({ id: row.id, name: row.name })),
        statuses: [...statusRows].sort((a, b) => a.position - b.position).map(row => ({ id: row.id, name: row.name, group: row.group })),
      };
    }),

    listMembers: (token, workspace) => authorizedRead(token, 'read', workspace, 'members.read', async s =>
      (await membersOf(s)).map(member => ({ membershipId: member.id, displayName: member.name, role: member.role }) as PublicMemberDto)),

    listTags: (token, workspace) => authorizedRead(token, 'read', workspace, READ_CAPABILITY, async s =>
      (await taskApp(s.tx).listTags(s.context)).filter(tag => tag.archivedAt === null).map(tag => ({ id: tag.id, name: tag.name }))),

    listTasks: (token, workspace, rawQuery) => authorizedRead(token, 'read', workspace, READ_CAPABILITY, async s => {
      const parsed = publicTaskListQuerySchema.safeParse(rawQuery);
      if (!parsed.success) throw new DomainError('VALIDATION_FAILED', 'Invalid task filter.');
      const query = parsed.data;
      const app = taskApp(s.tx);
      const allProjects = await projectItems(s);
      const filter: { -readonly [K in keyof ResolvedTaskFilter]: ResolvedTaskFilter[K] } = {};
      const chosenProjects = query.project ? matchRefs('project', query.project, allProjects) : null;
      if (chosenProjects) filter.projectIds = chosenProjects.map(project => project.id);
      const scopeProjects = chosenProjects ?? allProjects;
      const needsPerProject = (query.section?.length ?? 0) > 0 || (query.status?.length ?? 0) > 0;
      if (needsPerProject && scopeProjects.length > 50) throw new DomainError('VALIDATION_FAILED', 'Narrow the query with "project" before filtering by section or status name.');
      if (query.section?.length) {
        const all = (await Promise.all(scopeProjects.map(project => app.listSections(s.context, project.id)))).flat().filter(row => row.archivedAt === null);
        filter.sectionIds = matchRefs('section', query.section, all).map(row => row.id);
      }
      if (query.status?.length) {
        const all = (await Promise.all(scopeProjects.map(project => app.listStatuses(s.context, project.id)))).flat();
        filter.statusIds = matchRefs('status', query.status, all).map(row => row.id);
      }
      if (query.tag?.length) filter.tagIds = matchRefs('tag', query.tag, (await app.listTags(s.context)).filter(tag => tag.archivedAt === null)).map(tag => tag.id);
      if (query.assignee?.length) {
        const people = await membersOf(s);
        const ids: string[] = [];
        for (const value of query.assignee) {
          if (value.toLowerCase() === 'none') filter.unassigned = true;
          else ids.push(resolvePerson(s, value, people));
        }
        filter.assigneeIds = ids;
      }
      return listTaskViews(s.tx, s.workspaceId, query, filter, s.myMembershipId);
    }),

    getTask: (token, workspace, taskId) => authorizedRead(token, 'read', workspace, READ_CAPABILITY, async s => {
      if (!isUuid(taskId)) throw notFoundError();
      await taskApp(s.tx).getTask(s.context, taskId.toLowerCase());
      const view = await loadTaskView(s.tx, s.workspaceId, taskId.toLowerCase());
      if (!view) throw notFoundError();
      return view;
    }),

    async createTask(token, workspace, rawInput, writeOptions) {
      const parsed = publicTaskCreateSchema.safeParse(rawInput);
      if (!parsed.success) throw new DomainError('VALIDATION_FAILED', 'Invalid task.', { details: { issues: parsed.error.issues.slice(0, 10).map(issue => ({ path: issue.path.join('.'), message: issue.message })) } });
      const plan = await prepared(token, workspace, async (s, hash) => ({ hash, workspaceId: s.workspaceId, userId: s.principal.userId, context: await writeContext(s, writeOptions), input: await buildCreateInput(s, parsed.data) }));
      const created = await writeApp(plan.hash, plan.workspaceId, plan.userId).createTask(plan.context, plan.input);
      return authorizedRead(token, 'read', plan.workspaceId, READ_CAPABILITY, async s => {
        const view = await loadTaskView(s.tx, s.workspaceId, created.id);
        if (!view) throw notFoundError();
        return view;
      });
    },

    async updateTask(token, workspace, taskId, rawInput, writeOptions) {
      const parsed = publicTaskUpdateSchema.safeParse(rawInput);
      if (!parsed.success) throw new DomainError('VALIDATION_FAILED', 'Invalid task change.', { details: { issues: parsed.error.issues.slice(0, 10).map(issue => ({ path: issue.path.join('.'), message: issue.message })) } });
      if (!isUuid(taskId)) throw notFoundError();
      const change = parsed.data;
      const targetId = taskId.toLowerCase();
      // The public body is bound before looking up mutable names. Internal revisions and ids are resolved only once.
      const owner = await prepared(token, workspace, async (s, hash) => ({
        hash, workspaceId: s.workspaceId, userId: s.principal.userId,
        context: await writeContext(s, writeOptions),
      }));
      const key = owner.context.idempotencyKey;
      if (!key) throw new DomainError('VALIDATION_FAILED', 'A valid Idempotency-Key is required.');
      const command = 'public.task.update';
      const payloadHash = createHash('sha256').update(JSON.stringify({ taskId: targetId, input: change })).digest('hex');
      type Plan = {
        input: UpdateTaskInput; view: TaskView;
        people: { id: string; name: string }[];
        statuses: TaskView['status'][];
        sections: NonNullable<TaskView['section']>[];
        tags: TaskView['tags'];
      };
      type Outcome = { state: 'done'; view: TaskView } | {
        state: 'rejected'; code: DomainError['code']; message: string; details: unknown;
      };
      const conflict = () => new DomainError('IDEMPOTENCY_KEY_REUSED', 'This key was used for another public task update.');
      const outcomeValue = (value: Outcome): TaskView => {
        if (value.state === 'rejected') throw new DomainError(value.code, value.message, { details: value.details });
        return taskViewSchema.parse(value.view);
      };
      const metadata = createWorkspaceWriteRunner(source, {
        ...options,
        authorizeInScope: async scope => {
          const principal = await loadPrincipal(scope.tx, owner.hash, scope.barrierAt, true);
          requireScope(principal, 'tasks:write');
          if (principal.userId !== owner.userId || (principal.workspaceIds !== null && !principal.workspaceIds.includes(owner.workspaceId))) throw notFoundError();
          return { apiTokenId: principal.tokenId };
        },
      });
      const barrier = <T>(work: (s: ReadScope) => Promise<T>) => metadata.run(owner.context, 'task.edit', async scope => {
        const principal = await loadPrincipal(scope.tx, owner.hash, scope.barrierAt, true);
        if (!await createTaskRepository(scope.tx).findTask(owner.workspaceId, targetId)) throw notFoundError();
        return work({ tx: scope.tx, principal, workspaceId: owner.workspaceId, context: owner.context,
          role: scope.access.membership.role, myMembershipId: scope.access.membership.id });
      });
      const storedOutcome = async (s: ReadScope): Promise<Outcome | null> => {
        const receipt = await createTaskRepository(s.tx).findIdempotency(owner.workspaceId, owner.userId, command, key);
        if (!receipt) return null;
        if (receipt.payloadHash !== payloadHash) throw conflict();
        return receipt.result as Outcome;
      };
      const saveOutcome = async (s: ReadScope, value: Outcome): Promise<Outcome> => {
        const previous = await storedOutcome(s);
        if (previous) return previous;
        await createTaskRepository(s.tx).insertIdempotency({ workspaceId: owner.workspaceId, actorUserId: owner.userId,
          command, idempotencyKey: key, payloadHash, result: value, createdAt: (await databaseNow(s.tx)).toISOString() });
        return value;
      };
      const initial = await barrier(async s => {
        const outcome = await storedOutcome(s);
        if (outcome) return { outcome };
        const repo = createTaskRepository(s.tx);
        const claim = await repo.findIdempotency(owner.workspaceId, owner.userId, command + '.plan', key);
        if (claim) {
          if (claim.payloadHash !== payloadHash) throw conflict();
          const plan = claim.result as Plan;
          return { plan: { ...plan, input: updateTaskInputSchema.parse(plan.input), view: taskViewSchema.parse(plan.view) } };
        }
        // Earlier public clients wrote the ordinary task.update receipt under the raw caller key.
        // Its hash cannot prove the original public names/body, so never reinterpret it as a fresh operation.
        if (await repo.findIdempotency(owner.workspaceId, owner.userId, 'task.update', key)) {
          throw new DomainError('IDEMPOTENCY_KEY_REUSED', 'This key belongs to an earlier task update. Review the current task and use a new key.');
        }
        try {
          const app = taskApp(s.tx);
          const current = await app.getTask(s.context, targetId);
          if (change.ifRevision !== undefined && change.ifRevision !== current.revision) throw new DomainError('REVISION_CONFLICT', 'The task changed before this request.', { details: { currentRevision: current.revision } });
          const project = await app.getProject(s.context, current.projectId);
          if (current.archivedAt !== null || project.archivedAt !== null) throw new DomainError('DOMAIN_VALIDATION_FAILED', 'Restore the task and project before editing.');
          const people = await membersOf(s);
          const input: Record<string, unknown> = { expectedRevision: change.ifRevision ?? current.revision };
          let changed = false;
          const set = (key: string, value: unknown, same: boolean) => { if (!same) { input[key] = value; changed = true; } };
          if (change.title !== undefined) set('title', change.title, change.title === current.title);
          if (change.description !== undefined) set('description', change.description, change.description === current.description);
          if (change.priority !== undefined) set('priority', change.priority, change.priority === current.priority);
          if (change.startDate !== undefined) set('startDate', change.startDate, change.startDate === (current.startDate ?? null));
          if (change.dueDate !== undefined) set('dueDate', change.dueDate, change.dueDate === current.dueDate);
          if (change.status !== undefined) { const status = resolveRef('status', change.status, await app.listStatuses(s.context, current.projectId)); set('statusId', status.id, status.id === current.statusId); }
          if (change.section !== undefined) {
            const sectionId = change.section === null ? null : resolveRef('section', change.section, (await app.listSections(s.context, current.projectId)).filter(row => row.archivedAt === null)).id;
            set('sectionId', sectionId, sectionId === current.sectionId);
          }
          if (change.assignee !== undefined) {
            const id = change.assignee === null || change.assignee.toLowerCase() === 'none' ? null : resolvePerson(s, change.assignee, people);
            set('responsibleMembershipId', id, id === current.responsibleMembershipId);
          }
          if (change.participants !== undefined) {
            const ids = [...new Set(change.participants.map(value => resolvePerson(s, value, people, 'participant')))].sort();
            const now = current.participants.filter(row => row.active).map(row => row.membershipId).sort();
            if (JSON.stringify(ids) !== JSON.stringify(now)) { input.participantMembershipIds = ids; input.expectedParticipantsRevision = current.participantsRevision; changed = true; }
          }
          if (change.tags !== undefined) {
            const ids = resolveRefs('tag', change.tags, (await app.listTags(s.context)).filter(tag => tag.archivedAt === null)).map(tag => tag.id).sort();
            if (JSON.stringify(ids) !== JSON.stringify(current.tags.map(tag => tag.id).sort())) { input.tagIds = ids; changed = true; }
          }
          if (change.estimateMinutes !== undefined && change.estimateMinutes !== current.estimateMinutes) { input.estimateMinutes = change.estimateMinutes; input.expectedWorkPackageRevision = current.workPackageRevision; changed = true; }
          const view = await loadTaskView(s.tx, owner.workspaceId, targetId);
          if (!view) throw notFoundError();
          if (!changed) return { outcome: await saveOutcome(s, { state: 'done', view }) };
          const internalInput = updateTaskInputSchema.parse(input);
          const personIds = new Set([
            ...view.participants.map(person => person.membershipId),
            ...(view.assignee ? [view.assignee.membershipId] : []),
            ...(internalInput.participantMembershipIds ?? []),
            ...(internalInput.responsibleMembershipId ? [internalInput.responsibleMembershipId] : []),
          ]);
          const plan: Plan = {
            input: internalInput, view,
            people: people.filter(person => personIds.has(person.id)).map(({ id, name }) => ({ id, name })),
            statuses: (await app.listStatuses(s.context, current.projectId))
              .filter(status => status.id === current.statusId || status.id === internalInput.statusId)
              .map(({ id, name, group }) => ({ id, name, group })),
            sections: (await app.listSections(s.context, current.projectId))
              .filter(section => section.id === current.sectionId || section.id === internalInput.sectionId)
              .map(({ id, name }) => ({ id, name })),
            tags: [...view.tags, ...(change.tags ? (await app.listTags(s.context))
              .filter(tag => internalInput.tagIds?.includes(tag.id)).map(({ id, name }) => ({ id, name })) : [])],
          };
          await repo.insertIdempotency({ workspaceId: owner.workspaceId, actorUserId: owner.userId,
            command: command + '.plan', idempotencyKey: key, payloadHash, result: plan, createdAt: (await databaseNow(s.tx)).toISOString() });
          return { plan };
        } catch (error) {
          if (!isDomainError(error) || error.retryable) throw error;
          return { outcome: await saveOutcome(s, { state: 'rejected', code: error.code, message: error.message, details: error.details ?? null }) };
        }
      });
      if ('outcome' in initial) return outcomeValue(initial.outcome);
      const plan = initial.plan;
      let updated: TaskDto;
      try {
        // Intentionally top-level: a mandatory planning freeze/tagged rejection commits independently.
        const internalKey = createHash('sha256').update(`${key}\0public.task.update\0${targetId}`).digest('hex');
        updated = await writeApp(owner.hash, owner.workspaceId, owner.userId).updateTask(
          { ...owner.context, idempotencyKey: internalKey }, targetId, plan.input);
      } catch (error) {
        if (!isDomainError(error) || error.retryable) throw error;
        const rejected: Outcome = { state: 'rejected', code: error.code, message: error.message, details: error.details ?? null };
        // Failure to persist this metadata cannot turn a known domain rejection into success.
        try { return outcomeValue(await barrier(s => saveOutcome(s, rejected))); } catch { throw error; }
      }
      const person = (membershipId: string) => ({ membershipId,
        displayName: plan.people.find(member => member.id === membershipId)?.name
          ?? [plan.view.assignee, ...plan.view.participants].find(member => member?.membershipId === membershipId)?.displayName
          ?? 'Unknown member' });
      // Data comes from the durable domain ACK; catalog labels come from the pinned plan, never a later mutable GET.
      const view: TaskView = {
        ...plan.view, title: updated.title, description: updated.description,
        section: updated.sectionId === null ? null : plan.sections.find(section => section.id === updated.sectionId) ?? plan.view.section,
        status: plan.statuses.find(status => status.id === updated.statusId) ?? plan.view.status,
        assignee: updated.responsibleMembershipId === null ? null : person(updated.responsibleMembershipId),
        participants: updated.participants.filter(member => member.active).map(member => person(member.membershipId)),
        priority: updated.priority, startDate: updated.startDate ?? null, dueDate: updated.dueDate,
        estimateMinutes: updated.estimateMinutes,
        tags: updated.tags.map(tag => plan.tags.find(item => item.id === tag.id) ?? { id: tag.id, name: tag.name }),
        parentTaskId: updated.parentTaskId, revision: updated.revision, archived: updated.archivedAt !== null,
        createdAt: updated.createdAt, updatedAt: updated.updatedAt,
      };
      return outcomeValue(await barrier(s => saveOutcome(s, { state: 'done', view: taskViewSchema.parse(view) })));
    },
  };
}
