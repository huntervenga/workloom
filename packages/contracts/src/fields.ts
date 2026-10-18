import { z } from 'zod';

import { envelopeSchema } from './common/envelope.js';
import { idSchema } from './common/ids.js';
import { createTaskFieldDataSchema } from './common/task-field-data.js';
import {
  calendarDateSchema,
  minutesSchema,
  positionSchema,
  revisionSchema,
  utcTimestampSchema,
} from './tasks.js';

/**
 * P1b typed custom task fields, shared project column settings and value history.
 *
 * HTTP catalog, every path under `/api/v1/workspaces/:workspaceId`:
 * - `GET /fields` (`taskFieldListQuerySchema`) → `taskFieldDefinitionListResponseSchema`
 * - `POST /fields` (`createTaskFieldInputSchema`) → `taskFieldDefinitionResponseSchema`, 201
 * - `PATCH /fields/:fieldId` (`updateTaskFieldInputSchema`) → `taskFieldDefinitionResponseSchema`
 * - `POST /fields/:fieldId/options` (`createTaskFieldOptionInputSchema`) → `taskFieldDefinitionResponseSchema`, 201
 * - `PATCH /fields/:fieldId/options/:optionId` (`updateTaskFieldOptionInputSchema`) → `taskFieldDefinitionResponseSchema`
 * - `GET /projects/:projectId/columns` → `projectColumnsResponseSchema`
 * - `PATCH /projects/:projectId/columns` (`updateProjectColumnsInputSchema`) → `projectColumnsResponseSchema`
 * - `GET /tasks/:taskId/field-values` → `taskFieldValueListResponseSchema`
 * - `GET /projects/:projectId/field-values?taskIds=a,b` (`taskFieldBatchQuerySchema`) → `taskFieldValueListResponseSchema`
 * - `PUT /tasks/:taskId/field-values/:fieldId` (`setTaskFieldValueInputSchema`) → `taskFieldValueResponseSchema`
 * - `GET /tasks/:taskId/field-values/:fieldId/history` (`taskFieldHistoryQuerySchema`) →
 *   `taskFieldValueHistoryListResponseSchema`, next page in `meta.nextCursor`
 *
 * `POST` returns 201 and every other write 200; every write requires an `Idempotency-Key`
 * header. The actor and workspace come from the server context, never from a body. Errors:
 * missing or foreign references 404; same-workspace references in an incompatible project 422;
 * a denied capability 403; a stale `expectedRevision` or `expectedDefinitionRevision` 409; a
 * value write to a locked field 409 `FIELD_LOCKED`.
 *
 * These schemas check shape only. Domain commands must still enforce:
 * - fields are project-scoped; options exist only on `single_select`/`multi_select` fields
 *   (otherwise 422); the type is immutable (a PATCH with a different `type` is 422); field and
 *   option IDs are stable across rename and archive;
 * - select values reference options of the same field, `person` values reference workspace
 *   memberships (not task participants); archived options stay readable but cannot be newly set;
 * - column settings are shared project settings guarded by `fields.manage`, not a personal view.
 *   Settings start at revision 1 before any field exists. A full update must list exactly the
 *   active fields, with no missing or foreign IDs; archived fields are not returned. Creating a
 *   field appends it and bumps the settings revision in the same transaction; archive and
 *   restore reconcile and bump as well. Values and history are always retained;
 * - a value row starts at revision 1 (`expectedRevision: 0` for an absent row), including an
 *   explicit typed `null`, which clears and is not the same as an absent row. Writing the
 *   unchanged value is a no-op without revision bump or history. Values are independent of the
 *   task, its work package and participants;
 * - history is recorded only for changed values while `historyEnabled`; turning it off never
 *   deletes, turning it on does not backfill. Each entry keeps an immutable definition snapshot
 *   (labels, options, colors, policy), so later renames do not relabel the past.
 *
 * Only type-immutable custom fields are covered: no built-in estimate or weekly baseline binding
 * and no migration of the P1a `priority` yet; those need a future explicit bridge.
 */

const MAX_INT32 = 2_147_483_647;

export const taskFieldTypeSchema = z.enum([
  'text',
  'number',
  'duration',
  'date',
  'single_select',
  'multi_select',
  'person',
  'boolean',
  'url',
]);

const SELECT_TYPES: readonly TaskFieldType[] = ['single_select', 'multi_select'];

const fieldNameSchema = z.string().trim().min(1).max(160);
const optionNameSchema = z.string().trim().min(1).max(100);
const optionColorSchema = z
  .string()
  .regex(/^#[0-9a-f]{6}$/i, { error: 'Expected a #rrggbb color.' })
  .toLowerCase();

function hasUniqueValues(values: readonly (string | number)[]): boolean {
  return new Set(values).size === values.length;
}

function hasAnyField<T extends object>(value: T, keys: readonly (keyof T)[]): boolean {
  return keys.some((key) => value[key] !== undefined);
}

const noChangeError = { error: 'Provide at least one field to change.' } as const;

/**
 * A typed field value. Every type accepts `null` (an explicit clear), which is distinct from
 * `0`, `false`, `[]` and `''`. Text is kept verbatim (not trimmed). `duration` is whole minutes;
 * `date` is a calendar date without time or offset; select and `person` values are IDs, never
 * labels, and `person` refers to workspace memberships.
 */
export const taskFieldDataSchema = createTaskFieldDataSchema({ calendarDateSchema, minutesSchema });

/** Select option. Rename and archive keep the `id`; values never store the label. */
export const taskFieldOptionSchema = z.strictObject({
  id: idSchema,
  name: optionNameSchema,
  color: optionColorSchema.nullable(),
  position: positionSchema,
  revision: revisionSchema,
  archivedAt: utcTimestampSchema.nullable(),
});

/**
 * Current field definition. `revision` guards the definition and its whole option catalog;
 * `definitionVersionId` identifies the version that values and history entries were written with.
 */
export const taskFieldDefinitionSchema = z
  .strictObject({
    id: idSchema,
    workspaceId: idSchema,
    projectId: idSchema,
    name: fieldNameSchema,
    type: taskFieldTypeSchema,
    revision: revisionSchema,
    definitionVersionId: idSchema,
    historyEnabled: z.boolean(),
    locked: z.boolean(),
    archivedAt: utcTimestampSchema.nullable(),
    options: z.array(taskFieldOptionSchema),
    createdAt: utcTimestampSchema,
    updatedAt: utcTimestampSchema,
  })
  .superRefine((field, ctx) => {
    if (!SELECT_TYPES.includes(field.type) && field.options.length > 0) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'Only select fields have options.' });
    }
    if (!hasUniqueValues(field.options.map((option) => option.id))) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'Option IDs must be unique.' });
    }
  });

const projectColumnSchema = z.strictObject({
  fieldId: idSchema,
  visible: z.boolean(),
  width: z.number().int().min(80).max(640),
  position: positionSchema,
});

type ProjectColumn = z.infer<typeof projectColumnSchema>;

const uniqueColumnFieldIds = (columns: readonly ProjectColumn[]) =>
  hasUniqueValues(columns.map((column) => column.fieldId));
const uniqueColumnPositions = (columns: readonly ProjectColumn[]) =>
  hasUniqueValues(columns.map((column) => column.position));
const columnFieldIdsError = { error: 'Column field IDs must be unique.' } as const;
const columnPositionsError = { error: 'Column positions must be unique.' } as const;

/** Shared project column settings for active fields. Revision 1 exists before any field. */
export const projectColumnsSchema = z.strictObject({
  workspaceId: idSchema,
  projectId: idSchema,
  revision: revisionSchema,
  columns: z
    .array(projectColumnSchema)
    .refine(uniqueColumnFieldIds, columnFieldIdsError)
    .refine(uniqueColumnPositions, columnPositionsError),
});

/** Current value row. A row holding typed `null` is an explicit clear with its own revision. */
export const taskFieldValueSchema = z.strictObject({
  workspaceId: idSchema,
  projectId: idSchema,
  taskId: idSchema,
  fieldId: idSchema,
  definitionVersionId: idSchema,
  revision: revisionSchema,
  value: taskFieldDataSchema,
  updatedAt: utcTimestampSchema,
});

const taskFieldChangeSourceSchema = z.enum(['web', 'api', 'mcp', 'job', 'import']);

/** Decimal digits without leading zeros: a bigint sequence that must not lose precision in JSON. */
const changeSeqSchema = z.string().regex(/^(0|[1-9][0-9]{0,19})$/, { error: 'Expected a decimal sequence.' });

/**
 * One recorded value change. `definition` is the immutable snapshot taken at write time.
 * `before: null` means there was no row; `after` with a typed `null` value is a clear.
 */
export const taskFieldValueHistorySchema = z
  .strictObject({
    id: idSchema,
    workspaceId: idSchema,
    projectId: idSchema,
    taskId: idSchema,
    fieldId: idSchema,
    valueRevision: revisionSchema,
    definition: taskFieldDefinitionSchema,
    before: taskFieldDataSchema.nullable(),
    after: taskFieldDataSchema,
    actor: z.strictObject({ id: idSchema, displayName: z.string() }),
    source: taskFieldChangeSourceSchema,
    recordedAt: utcTimestampSchema,
    changeSeq: changeSeqSchema,
    eventOrdinal: z.number().int().min(1).max(MAX_INT32),
  })
  .superRefine((entry, ctx) => {
    if (entry.definition.id !== entry.fieldId) {
      ctx.addIssue({ code: 'custom', path: ['definition', 'id'], message: 'Snapshot must describe fieldId.' });
    }
    if (entry.after.type !== entry.definition.type) {
      ctx.addIssue({ code: 'custom', path: ['after', 'type'], message: 'Value type must match the field type.' });
    }
    if (entry.before !== null && entry.before.type !== entry.definition.type) {
      ctx.addIssue({ code: 'custom', path: ['before', 'type'], message: 'Value type must match the field type.' });
    }
  });

const optionInputSchema = z.strictObject({
  name: optionNameSchema,
  color: optionColorSchema.nullable().default(null),
});

export const createTaskFieldInputSchema = z.strictObject({
  projectId: idSchema,
  name: fieldNameSchema,
  type: taskFieldTypeSchema,
  historyEnabled: z.boolean().default(true),
  locked: z.boolean().default(false),
  options: z.array(optionInputSchema).max(100).default([]),
});

/** `type` is accepted only so the domain can answer 422 when it differs; it never migrates data. */
export const updateTaskFieldInputSchema = z
  .strictObject({
    expectedRevision: revisionSchema,
    name: fieldNameSchema.optional(),
    type: taskFieldTypeSchema.optional(),
    historyEnabled: z.boolean().optional(),
    locked: z.boolean().optional(),
    archived: z.boolean().optional(),
  })
  .refine((input) => hasAnyField(input, ['name', 'type', 'historyEnabled', 'locked', 'archived']), noChangeError);

/** `expectedRevision` is the field revision, which guards the whole option catalog. */
export const createTaskFieldOptionInputSchema = z.strictObject({
  expectedRevision: revisionSchema,
  name: optionNameSchema,
  color: optionColorSchema.nullable().default(null),
  position: positionSchema.optional(),
});

/** `expectedRevision` is the field revision, not the option revision. */
export const updateTaskFieldOptionInputSchema = z
  .strictObject({
    expectedRevision: revisionSchema,
    name: optionNameSchema.optional(),
    color: optionColorSchema.nullable().optional(),
    position: positionSchema.optional(),
    archived: z.boolean().optional(),
  })
  .refine((input) => hasAnyField(input, ['name', 'color', 'position', 'archived']), noChangeError);

/** Full replacement; an empty list is valid for a project without active fields. */
export const updateProjectColumnsInputSchema = z.strictObject({
  expectedRevision: revisionSchema,
  columns: z
    .array(projectColumnSchema)
    .max(100)
    .refine(uniqueColumnFieldIds, columnFieldIdsError)
    .refine(uniqueColumnPositions, columnPositionsError),
});

/**
 * `expectedRevision: 0` creates the row (an explicit `null` too); an existing row needs its
 * current revision. `expectedDefinitionRevision` is the field `revision` the client edited against.
 */
export const setTaskFieldValueInputSchema = z.strictObject({
  expectedRevision: z.number().int().min(0),
  expectedDefinitionRevision: revisionSchema,
  value: taskFieldDataSchema,
});

export const taskFieldListQuerySchema = z.strictObject({
  projectId: idSchema,
});

/** Accepts `taskIds=a,b` (or a repeated parameter) and yields a lowercase, unique, sorted list. */
export const taskFieldBatchQuerySchema = z.strictObject({
  taskIds: z
    .preprocess(
      (value) => (typeof value === 'string' ? value.split(',') : value),
      z.array(idSchema).min(1).max(200),
    )
    .refine(hasUniqueValues, { error: 'Task IDs must be unique.' })
    .transform((ids) => [...ids].sort()),
});

/**
 * The cursor is opaque here. The domain binds it to actor, workspace, permission epoch, task and
 * field and signs it with a process secret; a cursor failing those checks is rejected there.
 */
export const taskFieldHistoryQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(2048).optional(),
});

export const taskFieldDefinitionResponseSchema = envelopeSchema(taskFieldDefinitionSchema);
export const taskFieldDefinitionListResponseSchema = envelopeSchema(z.array(taskFieldDefinitionSchema));
export const projectColumnsResponseSchema = envelopeSchema(projectColumnsSchema);
export const taskFieldValueResponseSchema = envelopeSchema(taskFieldValueSchema);
export const taskFieldValueListResponseSchema = envelopeSchema(z.array(taskFieldValueSchema));
export const taskFieldValueHistoryListResponseSchema = envelopeSchema(z.array(taskFieldValueHistorySchema));

export type TaskFieldType = z.infer<typeof taskFieldTypeSchema>;
export type TaskFieldData = z.infer<typeof taskFieldDataSchema>;

export type TaskFieldOptionDto = z.infer<typeof taskFieldOptionSchema>;
export type TaskFieldDefinitionDto = z.infer<typeof taskFieldDefinitionSchema>;
export type ProjectColumnsDto = z.infer<typeof projectColumnsSchema>;
export type TaskFieldValueDto = z.infer<typeof taskFieldValueSchema>;
export type TaskFieldValueHistoryDto = z.infer<typeof taskFieldValueHistorySchema>;

export type CreateTaskFieldInput = z.infer<typeof createTaskFieldInputSchema>;
export type UpdateTaskFieldInput = z.infer<typeof updateTaskFieldInputSchema>;
export type CreateTaskFieldOptionInput = z.infer<typeof createTaskFieldOptionInputSchema>;
export type UpdateTaskFieldOptionInput = z.infer<typeof updateTaskFieldOptionInputSchema>;
export type UpdateProjectColumnsInput = z.infer<typeof updateProjectColumnsInputSchema>;
export type SetTaskFieldValueInput = z.infer<typeof setTaskFieldValueInputSchema>;
export type TaskFieldListQuery = z.infer<typeof taskFieldListQuerySchema>;
export type TaskFieldBatchQuery = z.infer<typeof taskFieldBatchQuerySchema>;
export type TaskFieldHistoryQuery = z.infer<typeof taskFieldHistoryQuerySchema>;

export type TaskFieldDefinitionResponse = z.infer<typeof taskFieldDefinitionResponseSchema>;
export type TaskFieldDefinitionListResponse = z.infer<typeof taskFieldDefinitionListResponseSchema>;
export type ProjectColumnsResponse = z.infer<typeof projectColumnsResponseSchema>;
export type TaskFieldValueResponse = z.infer<typeof taskFieldValueResponseSchema>;
export type TaskFieldValueListResponse = z.infer<typeof taskFieldValueListResponseSchema>;
export type TaskFieldValueHistoryListResponse = z.infer<typeof taskFieldValueHistoryListResponseSchema>;
