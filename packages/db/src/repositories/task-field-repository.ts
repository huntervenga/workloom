import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  taskFieldPolicySchema,
  taskFieldDataSchema,
  taskFieldValueHistorySchema,
  type ProjectColumnsDto,
  type TaskFieldData,
  type TaskFieldDefinitionDto,
  type TaskFieldOptionDto,
  type TaskFieldValueDto,
  type TaskFieldValueHistoryDto,
} from '@workloom/contracts';
import {
  DomainError,
  notFoundError,
  type TaskFieldHistoryAnchor,
  type TaskFieldOptionRecord,
  type TaskFieldRepository,
} from '@workloom/domain';

import { isDatabase, type Database, type WorkloomExecutor } from '../client.js';
import {
  projectColumnSettings,
  projectColumns,
  taskFieldDefinitionVersions,
  taskFieldDefinitions,
  taskFieldOptions,
  taskFieldValueHistory,
  taskFieldPolicies, taskFieldPolicyUsage,
  taskFieldValues,
  taskProjectPlacements,
} from '../schema.js';
import { createTaskRepository } from './task-repository.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHANGE_SEQ_PATTERN = /^[1-9][0-9]{0,18}$/;
const MAX_PG_BIGINT = 9_223_372_036_854_775_807n;
const MAX_INT32 = 2_147_483_647;
const FIELD_NAME_UNIQUE_CONSTRAINT = 'task_field_definitions_project_name_unique_idx';
const OPTION_NAME_UNIQUE_CONSTRAINT = 'task_field_options_field_name_unique_idx';
/** Keeps `IN (…)` lists far below the protocol's 65 535 bind-parameter limit. */
const ID_CHUNK_SIZE = 1000;

/** Malformed IDs cannot match any row; answering "absent" avoids a database cast error. */
function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** A malformed anchor cannot match any row; it must not reach the `bigint`/`uuid` casts. */
function isAnchor(anchor: TaskFieldHistoryAnchor): boolean {
  return (
    CHANGE_SEQ_PATTERN.test(anchor.changeSeq) &&
    BigInt(anchor.changeSeq) <= MAX_PG_BIGINT &&
    Number.isInteger(anchor.eventOrdinal) &&
    anchor.eventOrdinal >= 1 &&
    anchor.eventOrdinal <= MAX_INT32 &&
    isUuid(anchor.id)
  );
}

function chunks<T>(values: readonly T[], size = ID_CHUNK_SIZE): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < values.length; start += size) {
    result.push(values.slice(start, start + size));
  }
  return result;
}

function toIso(value: Date): string {
  return value.toISOString();
}

function toIsoOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function toDateOrNull(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

function assertUpdated(rows: readonly unknown[]): void {
  if (rows.length === 0) {
    throw notFoundError();
  }
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && typeof current === 'object' && current !== null; depth += 1) {
    const record = current as { code?: unknown; constraint_name?: unknown; cause?: unknown };
    if (record.code === '23505' && record.constraint_name === constraint) {
      return true;
    }
    current = record.cause;
  }
  return false;
}

/** Archived names stay reserved, so the messages must not imply the name is visible. */
function fieldNameTakenError(): DomainError {
  return new DomainError('DOMAIN_VALIDATION_FAILED', 'This field name is already used in the project.', {
    details: { fields: ['name'] },
  });
}

function optionNameTakenError(): DomainError {
  return new DomainError('DOMAIN_VALIDATION_FAILED', 'This option name is already used in the field.', {
    details: { fields: ['name'] },
  });
}

async function withNameGuard(
  constraint: string,
  conflict: () => DomainError,
  write: () => Promise<unknown>,
): Promise<void> {
  try {
    await write();
  } catch (error) {
    if (isUniqueViolation(error, constraint)) {
      throw conflict();
    }
    throw error;
  }
}

/** Stored JSON is re-validated against the public contract; the error never echoes the data. */
function parseValueData(value: unknown): TaskFieldData {
  const parsed = taskFieldDataSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('A stored task field value does not match its contract.');
  }
  return parsed.data;
}

function parseHistoryEntry(value: unknown): TaskFieldValueHistoryDto {
  const parsed = taskFieldValueHistorySchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('A stored task field history entry does not match its contract.');
  }
  return parsed.data;
}

function toOption(row: typeof taskFieldOptions.$inferSelect): TaskFieldOptionDto {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    position: row.position,
    revision: row.revision,
    archivedAt: toIsoOrNull(row.archivedAt),
  };
}

function toOptionRecord(row: typeof taskFieldOptions.$inferSelect): TaskFieldOptionRecord {
  return { ...toOption(row), workspaceId: row.workspaceId, projectId: row.projectId, fieldId: row.fieldId };
}

function toField(row: typeof taskFieldDefinitions.$inferSelect, options: TaskFieldOptionDto[]): TaskFieldDefinitionDto {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    name: row.name,
    type: row.type,
    revision: row.revision,
    definitionVersionId: row.definitionVersionId,
    historyEnabled: row.historyEnabled,
    locked: row.locked,
    archivedAt: toIsoOrNull(row.archivedAt),
    options,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

function toValue(row: typeof taskFieldValues.$inferSelect): TaskFieldValueDto {
  return {
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    taskId: row.taskId,
    fieldId: row.fieldId,
    definitionVersionId: row.definitionVersionId,
    revision: row.revision,
    value: parseValueData(row.value),
    updatedAt: toIso(row.updatedAt),
  };
}

/** Field row columns written by insertField and saveField; never options or versions. */
function fieldCoreValues(row: TaskFieldDefinitionDto) {
  return {
    name: row.name,
    revision: row.revision,
    definitionVersionId: row.definitionVersionId,
    historyEnabled: row.historyEnabled,
    locked: row.locked,
    archivedAt: toDateOrNull(row.archivedAt),
    updatedAt: new Date(row.updatedAt),
  };
}

/**
 * Drizzle implementation of the domain TaskFieldRepository: straight queries, projection and
 * persistence, no business rules, defaults or revision bumps. Every predicate names the
 * workspace explicitly. Pass a transaction so that reads and writes of one command share the
 * workspace barrier.
 */
export function createTaskFieldRepository(source: Database | WorkloomExecutor): TaskFieldRepository {
  const db: WorkloomExecutor = isDatabase(source) ? source.db : source;

  async function loadOptions(workspaceId: string, projectId: string, fieldId?: string): Promise<Map<string, TaskFieldOptionDto[]>> {
    const rows = await db
      .select()
      .from(taskFieldOptions)
      .where(
        and(
          eq(taskFieldOptions.workspaceId, workspaceId),
          eq(taskFieldOptions.projectId, projectId),
          fieldId === undefined ? undefined : eq(taskFieldOptions.fieldId, fieldId),
        ),
      )
      .orderBy(asc(taskFieldOptions.fieldId), asc(taskFieldOptions.position), asc(taskFieldOptions.id));
    const byField = new Map<string, TaskFieldOptionDto[]>();
    for (const row of rows) {
      const list = byField.get(row.fieldId) ?? [];
      list.push(toOption(row));
      byField.set(row.fieldId, list);
    }
    return byField;
  }

  return {
    policies: {
      async find(workspaceId,fieldId) {
        const [row]=await db.select().from(taskFieldPolicies).where(and(eq(taskFieldPolicies.workspaceId,workspaceId),eq(taskFieldPolicies.fieldId,fieldId)));
        return row?taskFieldPolicySchema.parse({...row,lockAt:toIsoOrNull(row.lockAt),activatedAt:toIsoOrNull(row.activatedAt),updatedAt:toIso(row.updatedAt)}):null;
      },
      async save(policy) {
        if(policy.updatedAt===null||policy.updatedByUserId===null)throw new Error('A stored policy requires its author and timestamp.');
        const row={...policy,lockAt:toDateOrNull(policy.lockAt),activatedAt:toDateOrNull(policy.activatedAt),updatedAt:new Date(policy.updatedAt),updatedByUserId:policy.updatedByUserId};
        await db.insert(taskFieldPolicies).values(row).onConflictDoUpdate({target:[taskFieldPolicies.workspaceId,taskFieldPolicies.fieldId],set:row});
      },
      async count(workspaceId,taskId,fieldId,actorUserId) {
        const [row]=await db.select({count:sql<number>`count(*)::integer`}).from(taskFieldPolicyUsage).where(and(eq(taskFieldPolicyUsage.workspaceId,workspaceId),eq(taskFieldPolicyUsage.taskId,taskId),eq(taskFieldPolicyUsage.fieldId,fieldId),eq(taskFieldPolicyUsage.actorUserId,actorUserId)));
        return row?.count??0;
      },
      async insertUsage(usage) {await db.insert(taskFieldPolicyUsage).values({...usage,recordedAt:new Date(usage.recordedAt)});},
    },
    tasks: createTaskRepository(db),
    async hasActivePlacement(workspaceId, taskId, projectId) {
      if (!isUuid(workspaceId) || !isUuid(taskId) || !isUuid(projectId)) return false;
      const [row] = await db.select({ id: taskProjectPlacements.id }).from(taskProjectPlacements)
        .where(and(eq(taskProjectPlacements.workspaceId, workspaceId), eq(taskProjectPlacements.taskId, taskId),
          eq(taskProjectPlacements.projectId, projectId), isNull(taskProjectPlacements.archivedAt))).limit(1);
      return row !== undefined;
    },

    async findField(workspaceId, fieldId) {
      if (!isUuid(workspaceId) || !isUuid(fieldId)) {
        return null;
      }
      const [row] = await db
        .select()
        .from(taskFieldDefinitions)
        .where(and(eq(taskFieldDefinitions.workspaceId, workspaceId), eq(taskFieldDefinitions.id, fieldId)))
        .limit(1);
      if (row === undefined) {
        return null;
      }
      const options = await loadOptions(row.workspaceId, row.projectId, row.id);
      return toField(row, options.get(row.id) ?? []);
    },

    async listFields(workspaceId, projectId) {
      if (!isUuid(workspaceId) || !isUuid(projectId)) {
        return [];
      }
      // Archived fields included; one options query for the whole project, not one per field.
      const rows = await db
        .select()
        .from(taskFieldDefinitions)
        .where(and(eq(taskFieldDefinitions.workspaceId, workspaceId), eq(taskFieldDefinitions.projectId, projectId)))
        .orderBy(asc(taskFieldDefinitions.createdAt), asc(taskFieldDefinitions.id));
      if (rows.length === 0) {
        return [];
      }
      const options = await loadOptions(workspaceId, projectId);
      return rows.map((row) => toField(row, options.get(row.id) ?? []));
    },

    async insertField(row) {
      // The definition_version_id FK is deferred: the version row follows in the same transaction.
      await withNameGuard(FIELD_NAME_UNIQUE_CONSTRAINT, fieldNameTakenError, () =>
        db.insert(taskFieldDefinitions).values({
          ...fieldCoreValues(row),
          id: row.id,
          workspaceId: row.workspaceId,
          projectId: row.projectId,
          type: row.type,
          createdAt: new Date(row.createdAt),
        }),
      );
    },

    async saveField(row) {
      // Ownership, project, type and creation time are immutable here.
      await withNameGuard(FIELD_NAME_UNIQUE_CONSTRAINT, fieldNameTakenError, async () => {
        const updated = await db
          .update(taskFieldDefinitions)
          .set(fieldCoreValues(row))
          .where(
            and(
              eq(taskFieldDefinitions.workspaceId, row.workspaceId),
              eq(taskFieldDefinitions.projectId, row.projectId),
              eq(taskFieldDefinitions.id, row.id),
            ),
          )
          .returning({ id: taskFieldDefinitions.id });
        assertUpdated(updated);
      });
    },

    async insertDefinitionVersion(snapshot) {
      await db.insert(taskFieldDefinitionVersions).values({
        id: snapshot.definitionVersionId,
        workspaceId: snapshot.workspaceId,
        projectId: snapshot.projectId,
        fieldId: snapshot.id,
        revision: snapshot.revision,
        snapshot,
        createdAt: new Date(snapshot.updatedAt),
      });
    },

    async findOption(workspaceId, optionId) {
      if (!isUuid(workspaceId) || !isUuid(optionId)) {
        return null;
      }
      // Archived options included: values and history keep referring to them.
      const [row] = await db
        .select()
        .from(taskFieldOptions)
        .where(and(eq(taskFieldOptions.workspaceId, workspaceId), eq(taskFieldOptions.id, optionId)))
        .limit(1);
      return row === undefined ? null : toOptionRecord(row);
    },

    async insertOption(row) {
      await withNameGuard(OPTION_NAME_UNIQUE_CONSTRAINT, optionNameTakenError, () =>
        db.insert(taskFieldOptions).values({
          id: row.id,
          workspaceId: row.workspaceId,
          projectId: row.projectId,
          fieldId: row.fieldId,
          name: row.name,
          color: row.color,
          position: row.position,
          revision: row.revision,
          archivedAt: toDateOrNull(row.archivedAt),
        }),
      );
    },

    async saveOption(row) {
      await withNameGuard(OPTION_NAME_UNIQUE_CONSTRAINT, optionNameTakenError, async () => {
        const updated = await db
          .update(taskFieldOptions)
          .set({
            name: row.name,
            color: row.color,
            position: row.position,
            revision: row.revision,
            archivedAt: toDateOrNull(row.archivedAt),
          })
          .where(
            and(
              eq(taskFieldOptions.workspaceId, row.workspaceId),
              eq(taskFieldOptions.projectId, row.projectId),
              eq(taskFieldOptions.fieldId, row.fieldId),
              eq(taskFieldOptions.id, row.id),
            ),
          )
          .returning({ id: taskFieldOptions.id });
        assertUpdated(updated);
      });
    },

    async findProjectColumns(workspaceId, projectId): Promise<ProjectColumnsDto | null> {
      if (!isUuid(workspaceId) || !isUuid(projectId)) {
        return null;
      }
      const [header] = await db
        .select()
        .from(projectColumnSettings)
        .where(and(eq(projectColumnSettings.workspaceId, workspaceId), eq(projectColumnSettings.projectId, projectId)))
        .limit(1);
      if (header === undefined) {
        return null;
      }
      const columns = await db
        .select({
          fieldId: projectColumns.fieldId,
          visible: projectColumns.visible,
          width: projectColumns.width,
          position: projectColumns.position,
        })
        .from(projectColumns)
        .where(and(eq(projectColumns.workspaceId, workspaceId), eq(projectColumns.projectId, projectId)))
        .orderBy(asc(projectColumns.position), asc(projectColumns.fieldId));
      return { workspaceId: header.workspaceId, projectId: header.projectId, revision: header.revision, columns };
    },

    async saveProjectColumns(row) {
      await db
        .insert(projectColumnSettings)
        .values({ workspaceId: row.workspaceId, projectId: row.projectId, revision: row.revision })
        .onConflictDoUpdate({
          target: [projectColumnSettings.workspaceId, projectColumnSettings.projectId],
          set: { revision: sql`excluded.revision` },
        });
      // Configuration only: values and history are never touched.
      await db
        .delete(projectColumns)
        .where(and(eq(projectColumns.workspaceId, row.workspaceId), eq(projectColumns.projectId, row.projectId)));
      for (const batch of chunks(row.columns)) {
        await db.insert(projectColumns).values(
          batch.map((column) => ({
            workspaceId: row.workspaceId,
            projectId: row.projectId,
            fieldId: column.fieldId,
            visible: column.visible,
            width: column.width,
            position: column.position,
          })),
        );
      }
    },

    async findValue(workspaceId, taskId, fieldId) {
      if (!isUuid(workspaceId) || !isUuid(taskId) || !isUuid(fieldId)) {
        return null;
      }
      const [row] = await db
        .select()
        .from(taskFieldValues)
        .where(
          and(
            eq(taskFieldValues.workspaceId, workspaceId),
            eq(taskFieldValues.taskId, taskId),
            eq(taskFieldValues.fieldId, fieldId),
          ),
        )
        .limit(1);
      return row === undefined ? null : toValue(row);
    },

    async listTaskValues(workspaceId, taskId) {
      if (!isUuid(workspaceId) || !isUuid(taskId)) {
        return [];
      }
      const rows = await db
        .select()
        .from(taskFieldValues)
        .where(and(eq(taskFieldValues.workspaceId, workspaceId), eq(taskFieldValues.taskId, taskId)))
        .orderBy(asc(taskFieldValues.fieldId));
      return rows.map(toValue);
    },

    async listProjectValues(workspaceId, projectId, taskIds) {
      const ids = [...new Set(taskIds)].filter(isUuid);
      if (!isUuid(workspaceId) || !isUuid(projectId) || ids.length === 0) {
        return [];
      }
      const result: TaskFieldValueDto[] = [];
      for (const batch of chunks(ids)) {
        const rows = await db
          .select()
          .from(taskFieldValues)
          .where(
            and(
              eq(taskFieldValues.workspaceId, workspaceId),
              eq(taskFieldValues.projectId, projectId),
              inArray(taskFieldValues.taskId, batch),
            ),
          )
          .orderBy(asc(taskFieldValues.taskId), asc(taskFieldValues.fieldId));
        result.push(...rows.map(toValue));
      }
      return result;
    },

    async saveValue(row) {
      // Only the value columns change; the project and field type of an existing row are fixed,
      // so a mismatching row is not updated and surfaces as absent.
      const saved = await db
        .insert(taskFieldValues)
        .values({
          workspaceId: row.workspaceId,
          projectId: row.projectId,
          taskId: row.taskId,
          fieldId: row.fieldId,
          fieldType: row.value.type,
          definitionVersionId: row.definitionVersionId,
          revision: row.revision,
          value: row.value,
          updatedAt: new Date(row.updatedAt),
        })
        .onConflictDoUpdate({
          target: [taskFieldValues.workspaceId, taskFieldValues.taskId, taskFieldValues.fieldId],
          set: {
            definitionVersionId: sql`excluded.definition_version_id`,
            revision: sql`excluded.revision`,
            value: sql`excluded.value`,
            updatedAt: sql`excluded.updated_at`,
          },
          setWhere: sql`${taskFieldValues.projectId} = excluded.project_id and ${taskFieldValues.fieldType} = excluded.field_type`,
        })
        .returning({ taskId: taskFieldValues.taskId });
      assertUpdated(saved);
    },

    async insertValueHistory(row) {
      // `before: null` is stored as SQL NULL (no prior row); a typed clear stays a JSON object.
      await db.insert(taskFieldValueHistory).values({
        id: row.id,
        workspaceId: row.workspaceId,
        projectId: row.projectId,
        taskId: row.taskId,
        fieldId: row.fieldId,
        definitionVersionId: row.definition.definitionVersionId,
        valueRevision: row.valueRevision,
        before: row.before,
        after: row.after,
        actorUserId: row.actor.id,
        actorDisplayName: row.actor.displayName,
        source: row.source,
        recordedAt: new Date(row.recordedAt),
        changeSeq: BigInt(row.changeSeq),
        eventOrdinal: row.eventOrdinal,
      });
    },

    async listValueHistory(workspaceId, taskId, fieldId, after, take) {
      if (!Number.isSafeInteger(take) || take < 0) {
        throw new TypeError('listValueHistory needs a non-negative integer take.');
      }
      if (
        take === 0 ||
        !isUuid(workspaceId) ||
        !isUuid(taskId) ||
        !isUuid(fieldId) ||
        (after !== null && !isAnchor(after))
      ) {
        return [];
      }
      const rows = await db
        .select({ entry: taskFieldValueHistory, snapshot: taskFieldDefinitionVersions.snapshot })
        .from(taskFieldValueHistory)
        // The immutable version snapshot, never the current field or options, labels the entry.
        .innerJoin(
          taskFieldDefinitionVersions,
          and(
            eq(taskFieldDefinitionVersions.workspaceId, taskFieldValueHistory.workspaceId),
            eq(taskFieldDefinitionVersions.projectId, taskFieldValueHistory.projectId),
            eq(taskFieldDefinitionVersions.fieldId, taskFieldValueHistory.fieldId),
            eq(taskFieldDefinitionVersions.id, taskFieldValueHistory.definitionVersionId),
          ),
        )
        .where(
          and(
            eq(taskFieldValueHistory.workspaceId, workspaceId),
            eq(taskFieldValueHistory.taskId, taskId),
            eq(taskFieldValueHistory.fieldId, fieldId),
            after === null
              ? undefined
              : sql`(${taskFieldValueHistory.changeSeq}, ${taskFieldValueHistory.eventOrdinal}, ${taskFieldValueHistory.id})
                  < (${after.changeSeq}::bigint, ${after.eventOrdinal}::integer, ${after.id}::uuid)`,
          ),
        )
        .orderBy(
          desc(taskFieldValueHistory.changeSeq),
          desc(taskFieldValueHistory.eventOrdinal),
          desc(taskFieldValueHistory.id),
        )
        .limit(take);
      return rows.map(({ entry, snapshot }) =>
        parseHistoryEntry({
          id: entry.id,
          workspaceId: entry.workspaceId,
          projectId: entry.projectId,
          taskId: entry.taskId,
          fieldId: entry.fieldId,
          valueRevision: entry.valueRevision,
          definition: snapshot,
          before: entry.before,
          after: entry.after,
          actor: { id: entry.actorUserId, displayName: entry.actorDisplayName },
          source: entry.source,
          recordedAt: toIso(entry.recordedAt),
          changeSeq: entry.changeSeq.toString(),
          eventOrdinal: entry.eventOrdinal,
        }),
      );
    },
  };
}
