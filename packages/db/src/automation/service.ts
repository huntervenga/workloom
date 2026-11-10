import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import {
  publicSetTaskFieldsResultSchema, publicSetTaskFieldsSchema, publicTaskAddToProjectSchema, publicTaskCreateSchema, publicTaskListQuerySchema, publicTaskProjectSchema, publicTaskUpdateSchema, publicTimeSummaryQuerySchema, taskViewSchema, updateTaskInputSchema,
  type PublicFieldDto, type PublicFieldValueDto, type PublicSetTaskFieldsResult, type PublicTimeSummaryDto, type TaskFieldData, type TaskFieldDefinitionDto, type TaskFieldValueDto,
  type ApiTokenDto, type ApiTokenScope, type CreateApiTokenInput, type CreatedApiTokenDto, type PublicMeDto, type PublicMemberDto,
  type PublicProjectDetailDto, type PublicProjectDto, type PublicTagDto, type PublicTaskCreate, type PublicTaskListQuery, type PublicTaskUpdate,
  type PublicTaskAddToProject, type PublicTaskProjectDto, type PublicWorkspaceDto, type TaskView, type UpdateTaskInput, type TaskDto,
} from '@workloom/contracts';
import { attributedAssignees, authorizeWorkspace, capabilityRequiredError, DomainError, isDomainError, listWorkspaceMembers, notFoundError, type Capability, type CommandContext } from '@workloom/domain';
import { isDatabase, type Database, type WorkloomExecutor } from '../client.js';
import { createAccessRepository } from '../repositories/access-repository.js';
import { createTaskRepository } from '../repositories/task-repository.js';
import { createTaskApplication } from '../tasks/task-application.js';
import { createTaskFieldApplication } from '../fields/task-field-application.js';
import { createLeaveApplication } from '../leave/application.js';
import { resolveField, sameTypedValue, toPublicField, toPublicFieldValue, toPublicValue, toTypedValue, type PersonLookup } from './fields.js';
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
  getTask(token: string, workspace: string | undefined, taskId: string, options?: { readonly includeFields?: boolean }): Promise<TaskView>;
  /** Custom fields of a project, with option names. */
  listFields(token: string, workspace: string | undefined, project: string): Promise<PublicFieldDto[]>;
  /** Writes custom field values by field name for up to 100 tasks; each value is its own field command. */
  setTaskFields(token: string, workspace: string | undefined, input: unknown, options: WriteOptions): Promise<PublicSetTaskFieldsResult>;
  /** Plan and fact per person in a project, next to the hours each person is expected to work in the range. */
  timeSummary(token: string, workspace: string | undefined, query: unknown): Promise<PublicTimeSummaryDto>;
  createTask(token: string, workspace: string | undefined, input: PublicTaskCreate, options: WriteOptions): Promise<TaskView>;
  updateTask(token: string, workspace: string | undefined, taskId: string, input: PublicTaskUpdate, options: WriteOptions): Promise<TaskView>;
  /** Shows an existing task in one more project (a placement); its home project, hours and fields stay where they are. */
  addTaskToProject(token: string, workspace: string | undefined, taskId: string, input: PublicTaskAddToProject, options: WriteOptions): Promise<PublicTaskProjectDto>;
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

  const fieldApp = (tx: WorkloomExecutor) => createTaskFieldApplication(tx, { cursorSecret });

  async function peopleLookup(s: ReadScope): Promise<PersonLookup> {
    const people = await membersOf(s);
    const names = new Map(people.map(person => [person.id.toLowerCase(), person.name]));
    return { name: id => names.get(id.toLowerCase()) ?? 'Unknown member', resolve: value => resolvePerson(s, value, people, 'person') };
  }

  async function activeFields(s: ReadScope, projectId: string): Promise<TaskFieldDefinitionDto[]> {
    return (await fieldApp(s.tx).listFields(s.context, projectId)).filter(field => field.archivedAt === null);
  }

  /** Current value rows by task id, then field id, for tasks placed in the project. */
  async function projectValues(s: ReadScope, projectId: string, taskIds: readonly string[]): Promise<Map<string, Map<string, TaskFieldValueDto>>> {
    const out = new Map<string, Map<string, TaskFieldValueDto>>();
    const unique = [...new Set(taskIds.map(id => id.toLowerCase()))];
    for (let start = 0; start < unique.length; start += 200) {
      const rows = await fieldApp(s.tx).listProjectValues(s.context, projectId, { taskIds: unique.slice(start, start + 200) });
      for (const row of rows) {
        const taskId = row.taskId.toLowerCase();
        const byField = out.get(taskId) ?? new Map<string, TaskFieldValueDto>();
        byField.set(row.fieldId.toLowerCase(), row);
        out.set(taskId, byField);
      }
    }
    return out;
  }

  /** Adds the values of each task's home project fields. */
  async function withFields(s: ReadScope, views: readonly TaskView[]): Promise<TaskView[]> {
    if (views.length === 0) return [];
    const lookup = await peopleLookup(s);
    const byProject = new Map<string, TaskView[]>();
    for (const view of views) byProject.set(view.project.id, [...(byProject.get(view.project.id) ?? []), view]);
    const fieldsByTask = new Map<string, PublicFieldValueDto[]>();
    for (const [projectId, list] of byProject) {
      const fields = await activeFields(s, projectId);
      const values = await projectValues(s, projectId, list.map(view => view.id));
      for (const view of list) fieldsByTask.set(view.id, fields.map(field => toPublicFieldValue(field, values.get(view.id.toLowerCase())?.get(field.id.toLowerCase()), lookup)));
    }
    return views.map(view => ({ ...view, fields: fieldsByTask.get(view.id) ?? [] }));
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
  function tokenInScope(hash: string, workspaceId: string, userId: string) {
    return async (scope: { readonly tx: WorkloomExecutor; readonly context: CommandContext; readonly barrierAt: Date }) => {
      const principal = await loadPrincipal(scope.tx, hash, scope.barrierAt, true);
      requireScope(principal, 'tasks:write');
      if (principal.userId !== userId || scope.context.workspaceId !== workspaceId || (principal.workspaceIds !== null && !principal.workspaceIds.includes(workspaceId))) throw notFoundError();
      return { apiTokenId: principal.tokenId };
    };
  }
  function writeApp(hash: string, workspaceId: string, userId: string) {
    return createTaskApplication(source, { ...options, cursorSecret, authorizeInScope: tokenInScope(hash, workspaceId, userId) });
  }
  function fieldWriteApp(hash: string, workspaceId: string, userId: string) {
    return createTaskFieldApplication(source, { ...options, cursorSecret, authorizeInScope: tokenInScope(hash, workspaceId, userId) });
  }

  async function prepared<T>(token: string, workspace: string | undefined, work: (s: ReadScope, hash: string) => Promise<T>): Promise<T> {
    const hash = parseApiToken(token);
    return authorizedRead(token, 'tasks:write', workspace, 'task.edit', s => work(s, hash));
  }

  type FieldChangeResult = PublicSetTaskFieldsResult['items'][number]['changes'][number];
  interface FieldWrite {
    readonly itemIndex: number; readonly changeIndex: number;
    readonly taskId: string; readonly projectId: string; readonly fieldId: string;
    readonly expectedRevision: number; readonly expectedDefinitionRevision: number; readonly value: TaskFieldData;
  }
  interface FieldPlan { readonly result: PublicSetTaskFieldsResult; readonly writes: readonly FieldWrite[] }

  const summarize = (items: PublicSetTaskFieldsResult['items']): PublicSetTaskFieldsResult['summary'] => {
    const all = items.flatMap(item => item.changes);
    return { changed: all.filter(change => change.status === 'changed').length, unchanged: all.filter(change => change.status === 'unchanged').length, failed: all.filter(change => change.status === 'failed').length };
  };
  const failure = (field: string, error: DomainError): FieldChangeResult => ({ field, fieldId: null, type: null, before: null, after: null, status: 'failed', error: { code: error.code, message: error.message } });
  const knownRejection = (error: unknown): error is DomainError => isDomainError(error) && !error.retryable;

  /** Resolves every change against current values. Known per-task or per-field problems become `failed` entries. */
  async function planFieldWrites(s: ReadScope, input: ReturnType<typeof publicSetTaskFieldsSchema.parse>, dryRun: boolean): Promise<FieldPlan> {
    const app = taskApp(s.tx);
    const lookup = await peopleLookup(s);
    const projects = await projectItems(s);
    const fieldsByProject = new Map<string, TaskFieldDefinitionDto[]>();
    const items: PublicSetTaskFieldsResult['items'] = [];
    const writes: FieldWrite[] = [];
    for (const [itemIndex, item] of input.items.entries()) {
      let title: string | null = null;
      let target: { id: string; name: string } | null = null;
      let fields: TaskFieldDefinitionDto[];
      let values: Map<string, TaskFieldValueDto>;
      let taskId = item.taskId;
      try {
        const task = await app.getTask(s.context, item.taskId);
        title = task.title; taskId = task.id;
        if (task.archivedAt !== null) throw new DomainError('DOMAIN_VALIDATION_FAILED', 'Restore the task before editing its fields.');
        const projectId = item.project === undefined ? task.projectId : resolveRef('project', item.project, projects).id;
        const project = projects.find(row => row.id === projectId) ?? { id: projectId, name: (await app.getProject(s.context, projectId)).name };
        target = { id: project.id, name: project.name };
        fields = fieldsByProject.get(projectId) ?? await activeFields(s, projectId);
        fieldsByProject.set(projectId, fields);
        values = (await projectValues(s, projectId, [task.id])).get(task.id.toLowerCase()) ?? new Map();
      } catch (error) {
        if (!knownRejection(error)) throw error;
        items.push({ taskId, title, project: target, changes: item.values.map(change => failure(change.field, error)) });
        continue;
      }
      const changes: FieldChangeResult[] = [];
      for (const change of item.values) {
        try {
          const field = resolveField(fields, change.field);
          if (field.locked) throw new DomainError('FIELD_LOCKED', `${field.name} is locked in this project.`);
          const row = values.get(field.id.toLowerCase());
          const current = row?.value ?? null;
          const next = toTypedValue(field, change.value, lookup);
          // An absent row and an explicit clear are distinct, but clearing a never-filled value changes nothing.
          const unchanged = row ? sameTypedValue(current, next) : next.value === null;
          changes.push({ field: field.name, fieldId: field.id, type: field.type, before: toPublicValue(field, current, lookup), after: toPublicValue(field, next, lookup), status: unchanged ? 'unchanged' : 'changed' });
          if (!unchanged) writes.push({ itemIndex, changeIndex: changes.length - 1, taskId, projectId: target.id, fieldId: field.id, expectedRevision: row?.revision ?? 0, expectedDefinitionRevision: field.revision, value: next });
        } catch (error) {
          if (!knownRejection(error)) throw error;
          changes.push(failure(change.field, error));
        }
      }
      items.push({ taskId, title, project: target, changes });
    }
    return { result: { dryRun, items, summary: summarize(items) }, writes };
  }

  async function setTaskFields(token: string, workspace: string | undefined, rawInput: unknown, writeOptions: WriteOptions): Promise<PublicSetTaskFieldsResult> {
    const parsed = publicSetTaskFieldsSchema.safeParse(rawInput);
    if (!parsed.success) throw new DomainError('VALIDATION_FAILED', 'Invalid field changes.', { details: { issues: parsed.error.issues.slice(0, 10).map(issue => ({ path: issue.path.join('.'), message: issue.message })) } });
    const input = parsed.data;
    if (input.dryRun === true) return authorizedRead(token, 'read', workspace, READ_CAPABILITY, s => planFieldWrites(s, input, true).then(plan => plan.result));

    const owner = await prepared(token, workspace, async (s, hash) => ({ hash, workspaceId: s.workspaceId, userId: s.principal.userId, context: await writeContext(s, writeOptions) }));
    const key = owner.context.idempotencyKey;
    if (!key) throw new DomainError('VALIDATION_FAILED', 'A valid Idempotency-Key is required.');
    const command = 'public.task_fields.set';
    const payloadHash = createHash('sha256').update(JSON.stringify({ items: input.items })).digest('hex');
    const conflict = () => new DomainError('IDEMPOTENCY_KEY_REUSED', 'This key was used for other field changes.');
    const runner = createWorkspaceWriteRunner(source, { ...options, authorizeInScope: tokenInScope(owner.hash, owner.workspaceId, owner.userId) });
    const barrier = <T>(work: (s: ReadScope) => Promise<T>) => runner.run(owner.context, 'task.edit', async scope => {
      const principal = await loadPrincipal(scope.tx, owner.hash, scope.barrierAt, true);
      return work({ tx: scope.tx, principal, workspaceId: owner.workspaceId, context: owner.context, role: scope.access.membership.role, myMembershipId: scope.access.membership.id });
    });
    const receipt = async (s: ReadScope, name: string) => {
      const found = await createTaskRepository(s.tx).findIdempotency(owner.workspaceId, owner.userId, name, key);
      if (found && found.payloadHash !== payloadHash) throw conflict();
      return found;
    };
    const store = (s: ReadScope, name: string, result: unknown) => databaseNow(s.tx).then(now => createTaskRepository(s.tx).insertIdempotency({
      workspaceId: owner.workspaceId, actorUserId: owner.userId, command: name, idempotencyKey: key, payloadHash, result, createdAt: now.toISOString() }));

    // The resolved plan (names, expected revisions, typed values) is pinned under the caller key, so a retry
    // repeats exactly the same field commands and each replays its own durable receipt.
    const initial = await barrier(async s => {
      const done = await receipt(s, command);
      if (done) return { done: done.result as PublicSetTaskFieldsResult };
      const claimed = await receipt(s, command + '.plan');
      if (claimed) return { plan: claimed.result as FieldPlan };
      const plan = await planFieldWrites(s, input, false);
      await store(s, command + '.plan', plan);
      return { plan };
    });
    if ('done' in initial && initial.done) return publicSetTaskFieldsResultSchema.parse(initial.done);
    const plan = (initial as { plan: FieldPlan }).plan;
    const result = publicSetTaskFieldsResultSchema.parse(JSON.parse(JSON.stringify(plan.result)));
    const writer = fieldWriteApp(owner.hash, owner.workspaceId, owner.userId);
    for (const write of plan.writes) {
      const internalKey = createHash('sha256').update(`${key}\0${command}\0${write.taskId}\0${write.projectId}\0${write.fieldId}`).digest('hex');
      try {
        await writer.setTaskValue({ ...owner.context, idempotencyKey: internalKey }, write.taskId, write.fieldId,
          { expectedRevision: write.expectedRevision, expectedDefinitionRevision: write.expectedDefinitionRevision, value: write.value });
      } catch (error) {
        if (!knownRejection(error)) throw error;
        const change = result.items[write.itemIndex]?.changes[write.changeIndex];
        if (change) { change.status = 'failed'; change.error = { code: error.code, message: error.message }; }
      }
    }
    const final: PublicSetTaskFieldsResult = { ...result, summary: summarize(result.items) };
    return barrier(async s => {
      const done = await receipt(s, command);
      if (done) return publicSetTaskFieldsResultSchema.parse(done.result);
      await store(s, command, final);
      return final;
    });
  }

  async function timeSummary(token: string, workspace: string | undefined, rawQuery: unknown): Promise<PublicTimeSummaryDto> {
    const parsed = publicTimeSummaryQuerySchema.safeParse(rawQuery);
    if (!parsed.success) throw new DomainError('VALIDATION_FAILED', parsed.error.issues[0]?.message ?? 'Invalid time summary query.', { details: { issues: parsed.error.issues.slice(0, 10).map(issue => ({ path: issue.path.join('.'), message: issue.message })) } });
    const query = parsed.data;
    const base = await authorizedRead(token, 'read', workspace, READ_CAPABILITY, async s => {
      const app = taskApp(s.tx);
      const project = await app.getProject(s.context, resolveRef('project', query.project, await projectItems(s)).id);
      const range = query.from !== undefined && query.to !== undefined ? { from: query.from, to: query.to, source: 'input' as const }
        : project.dateRange ? { from: project.dateRange.from, to: project.dateRange.to, source: 'project' as const } : null;
      if (!range) throw new DomainError('VALIDATION_FAILED', `Project "${project.name}" has no date range. Pass from and to.`, { details: { field: 'from', reason: 'required' } });
      const fields = await activeFields(s, project.id);
      const planField = resolveField(fields, query.planField, 'planField');
      const factField = resolveField(fields, query.factField, 'factField');
      for (const field of [planField, factField]) if (field.type !== 'duration') throw new DomainError('VALIDATION_FAILED', `${field.name} is a ${field.type} field, not a duration.`, { details: { field: field.id === planField.id ? 'planField' : 'factField', reason: 'not_duration' } });
      const rows = [];
      let cursor: string | undefined;
      for (let page = 0; ; page += 1) {
        if (page === 10) throw new DomainError('VALIDATION_FAILED', 'The project has more than 2000 tasks; a time summary covers at most 2000.');
        if (!app.placements) throw new Error('Project rows are unavailable.');
        const result = await app.placements.listProjectRows(s.context, project.id, { limit: 200, includeArchived: false, ...(cursor ? { cursor } : {}) });
        rows.push(...result.items);
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }
      const live = rows.filter(row => row.canonicalTask.archivedAt === null && row.placement.archivedAt === null);
      const values = await projectValues(s, project.id, live.map(row => row.canonicalTask.id));
      const people = await membersOf(s);
      const selected = query.people ? [...new Set(query.people.map(value => resolvePerson(s, value, people, 'people')))] : null;
      return { project, range, planField, factField, live, values, people, selected, context: s.context, me: s.myMembershipId };
    });

    const minutes = (taskId: string, fieldId: string): number | null => {
      const value = base.values.get(taskId.toLowerCase())?.get(fieldId.toLowerCase())?.value;
      return value?.type === 'duration' ? value.value : null;
    };
    // A subtask without its own assignee counts for its nearest assigned parent, as in Reports.
    const assigneeOf = attributedAssignees(base.live.map(row => row.canonicalTask));
    const tasks = base.live.map(row => ({
      assignee: assigneeOf.get(row.canonicalTask.id.toLowerCase())?.toLowerCase() ?? null,
      view: {
        taskId: row.canonicalTask.id, title: row.canonicalTask.title, status: row.canonicalStatus.name, statusGroup: row.canonicalStatus.group,
        parentTaskId: row.canonicalTask.parentTaskId, planMinutes: minutes(row.canonicalTask.id, base.planField.id), factMinutes: minutes(row.canonicalTask.id, base.factField.id),
      },
    }));
    const active = new Map(base.people.map(person => [person.id.toLowerCase(), person]));
    const chosen = base.selected ?? [...new Set([...tasks.flatMap(task => task.assignee && active.has(task.assignee) ? [task.assignee] : []), ...(base.me ? [base.me.toLowerCase()] : [])])];
    const ids = chosen.map(id => id.toLowerCase()).filter(id => active.has(id)).slice(0, 100);
    const notes = [
      'Each task counts its own stored values; table rollups of subtasks into parents are not added again.',
      'Time belongs to the task assignee; a subtask without one counts for its nearest assigned parent task.',
    ];
    if (chosen.length > 100) notes.push('Only the first 100 people are included.');
    let capacity: Awaited<ReturnType<ReturnType<typeof createLeaveApplication>['availability']>> | null = null;
    if (ids.length > 0) {
      try {
        capacity = await createLeaveApplication(source).availability(base.context, { startDate: base.range.from, endDate: base.range.to, people: { kind: 'selected', membershipIds: ids } });
        if (!capacity.settingsConfigured) notes.push('Time off and working schedules are not configured in this workspace, so expected hours are unknown.');
      } catch (error) {
        if (!knownRejection(error)) throw error;
        notes.push(`Expected hours are unavailable: ${error.message}`);
      }
    }
    const sum = (list: readonly (number | null)[]) => list.reduce<number>((total, value) => total + (value ?? 0), 0);
    const people = ids.map(id => {
      const own = tasks.filter(task => task.assignee === id).map(task => task.view);
      const known = capacity?.members.find(member => member.membershipId.toLowerCase() === id);
      const scheduleKnown = capacity !== null && capacity.settingsConfigured && known?.scheduleKnown === true;
      const expected = scheduleKnown ? known?.availableMinutes ?? null : null;
      const fact = sum(own.map(task => task.factMinutes));
      return {
        membershipId: id, displayName: active.get(id)?.name ?? 'Unknown member', scheduleKnown,
        scheduledMinutes: scheduleKnown ? known?.scheduledMinutes ?? null : null,
        holidayMinutes: scheduleKnown ? known?.holidayMinutes ?? null : null,
        absenceMinutes: scheduleKnown ? known?.absenceMinutes ?? null : null,
        expectedMinutes: expected, planMinutes: sum(own.map(task => task.planMinutes)), factMinutes: fact,
        factGapMinutes: expected === null ? null : expected - fact,
        ...(query.includeTasks ? { tasks: own } : {}),
      };
    }).sort((a, b) => a.displayName.localeCompare(b.displayName));
    const unassignedTasks = tasks.filter(task => task.assignee === null).map(task => task.view);
    return {
      project: { id: base.project.id, name: base.project.name },
      from: base.range.from, to: base.range.to, rangeSource: base.range.source,
      planField: { id: base.planField.id, name: base.planField.name }, factField: { id: base.factField.id, name: base.factField.name },
      people,
      unassigned: { planMinutes: sum(unassignedTasks.map(task => task.planMinutes)), factMinutes: sum(unassignedTasks.map(task => task.factMinutes)), ...(query.includeTasks ? { tasks: unassignedTasks } : {}) },
      totals: { expectedMinutes: sum(people.map(person => person.expectedMinutes)), planMinutes: sum(people.map(person => person.planMinutes)), factMinutes: sum(people.map(person => person.factMinutes)) },
      notes,
    };
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
      const page = await listTaskViews(s.tx, s.workspaceId, query, filter, s.myMembershipId);
      return query.includeFields ? { ...page, items: await withFields(s, page.items) } : page;
    }),

    getTask: (token, workspace, taskId, readOptions) => authorizedRead(token, 'read', workspace, READ_CAPABILITY, async s => {
      if (!isUuid(taskId)) throw notFoundError();
      await taskApp(s.tx).getTask(s.context, taskId.toLowerCase());
      const view = await loadTaskView(s.tx, s.workspaceId, taskId.toLowerCase());
      if (!view) throw notFoundError();
      return readOptions?.includeFields ? (await withFields(s, [view]))[0] ?? view : view;
    }),

    listFields: (token, workspace, project) => authorizedRead(token, 'read', workspace, READ_CAPABILITY, async s => {
      const found = resolveRef('project', project, await projectItems(s));
      return (await activeFields(s, found.id)).map(toPublicField);
    }),

    setTaskFields: (token, workspace, rawInput, writeOptions) => setTaskFields(token, workspace, rawInput, writeOptions),
    timeSummary: (token, workspace, rawQuery) => timeSummary(token, workspace, rawQuery),

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
    async addTaskToProject(token, workspace, taskId, rawInput, writeOptions) {
      const parsed = publicTaskAddToProjectSchema.safeParse(rawInput);
      if (!parsed.success) throw new DomainError('VALIDATION_FAILED', 'Invalid project placement.', { details: { issues: parsed.error.issues.slice(0, 10).map(issue => ({ path: issue.path.join('.'), message: issue.message })) } });
      if (!isUuid(taskId)) throw notFoundError();
      const targetId = taskId.toLowerCase();
      // Names are resolved once under the caller's current access; each placement command rechecks access, revisions and project rules in its own transaction.
      const plan = await prepared(token, workspace, async (s, hash) => {
        const app = taskApp(s.tx);
        if (!app.placements) throw new Error('Project placements are unavailable.');
        const task = await app.getTask(s.context, targetId);
        if (task.archivedAt !== null) throw new DomainError('DOMAIN_VALIDATION_FAILED', 'Restore the task before adding it to another project.');
        const projects = await projectItems(s);
        const project = resolveRef('project', parsed.data.project, projects.filter(item => !item.archived));
        const home = projects.find(item => item.id === task.projectId) ?? { id: task.projectId, name: (await app.getProject(s.context, task.projectId)).name };
        const sections = (await app.listSections(s.context, project.id)).filter(row => row.archivedAt === null).map(({ id, name }) => ({ id, name }));
        const section = parsed.data.section === undefined || parsed.data.section === null ? null : resolveRef('section', parsed.data.section, sections);
        const existing = (await app.placements.listTaskPlacements(s.context, targetId)).find(row => row.projectId === project.id) ?? null;
        // A project tracks time when it has an active duration field, like the week projects' plan and fact.
        const tracksTime = async (projectId: string) => (await activeFields(s, projectId)).some(field => field.type === 'duration');
        const time = project.id === task.projectId ? null : { target: await tracksTime(project.id), home: await tracksTime(task.projectId) };
        return { hash, workspaceId: s.workspaceId, userId: s.principal.userId, context: await writeContext(s, writeOptions), task, project, home, sections, section, existing, time };
      });
      type Reason = PublicTaskProjectDto['homeReason'];
      const result = (outcome: PublicTaskProjectDto['outcome'], sectionId: string | null, homeNow: boolean, homeReason: Reason, copiedValues = 0): PublicTaskProjectDto => publicTaskProjectSchema.parse({
        taskId: plan.task.id, project: { id: plan.project.id, name: plan.project.name },
        section: sectionId === null ? null : plan.sections.find(row => row.id === sectionId) ?? null,
        home: homeNow, homeProject: homeNow ? { id: plan.project.id, name: plan.project.name } : { id: plan.home.id, name: plan.home.name },
        outcome, homeChanged: homeNow && plan.project.id !== plan.task.projectId, homeReason, copiedValues,
      });
      if (plan.project.id === plan.task.projectId) return result('unchanged', plan.task.sectionId, true, 'already_home');
      // The home moves only when asked, or when the target tracks time and the current home does not.
      // A subtask always shares its parent's home, so it is never moved by that rule.
      const time = plan.time ?? { target: false, home: false };
      let makeHome: boolean, reason: Reason;
      if (parsed.data.home !== undefined) { makeHome = parsed.data.home; reason = makeHome ? 'requested' : 'kept'; }
      else if (time.target && time.home) {
        throw new DomainError('VALIDATION_FAILED', `Both "${plan.home.name}" (the current home) and "${plan.project.name}" track time. Pass home: true to count the task's hours in "${plan.project.name}" from now on, or home: false to only show it there.`,
          { details: { field: 'home', reason: 'choice_required', homeProject: { id: plan.home.id, name: plan.home.name }, project: { id: plan.project.id, name: plan.project.name } } });
      } else { makeHome = time.target && plan.task.parentTaskId === null; reason = makeHome ? 'time_fields' : 'kept'; }
      const active = plan.existing !== null && plan.existing.archivedAt === null;
      if (!makeHome && active) return result('unchanged', plan.existing?.sectionId ?? null, false, reason);
      const commands = writeApp(plan.hash, plan.workspaceId, plan.userId).placements;
      if (!commands) throw new Error('Project placements are unavailable.');
      const internalKey = (command: string) => createHash('sha256').update(`${plan.context.idempotencyKey ?? ''}\0public.task.project.${command}\0${targetId}\0${plan.project.id}`).digest('hex');
      if (makeHome) {
        // One command: the target becomes the home (an existing or removed placement there turns into the home row),
        // and the former home stays among the task's projects.
        const sectionId = plan.section?.id ?? (active ? plan.existing?.sectionId ?? null : undefined);
        const moved = await commands.transferTaskProject({ ...plan.context, idempotencyKey: internalKey('home') }, targetId,
          { expectedRevision: plan.task.revision, projectId: plan.project.id, keepFormerHome: true, ...(sectionId !== undefined ? { sectionId } : {}) });
        return result(active ? 'unchanged' : plan.existing ? 'restored' : 'added', moved.task.sectionId, true, reason, moved.carriedValues);
      }
      if (plan.existing) {
        let row = await commands.restoreTaskProjectPlacement({ ...plan.context, idempotencyKey: internalKey('restore') }, plan.existing.id, { expectedRevision: plan.existing.revision });
        if (plan.section && plan.section.id !== row.sectionId) row = await commands.updateTaskProjectPlacement({ ...plan.context, idempotencyKey: internalKey('section') }, row.id, { expectedRevision: row.revision, sectionId: plan.section.id });
        return result('restored', row.sectionId, false, reason);
      }
      const row = await commands.attachTaskProject({ ...plan.context, idempotencyKey: internalKey('attach') }, targetId, { projectId: plan.project.id, expectedTaskRevision: plan.task.revision, sectionId: plan.section?.id ?? null });
      return result('added', row.sectionId, false, reason);
    },
  };
}
