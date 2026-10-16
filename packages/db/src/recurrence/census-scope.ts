import {createDependencyRepository} from '../repositories/dependency-repository.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  createTaskStatusTransitionPolicy,
  createRecurrenceOccurrenceComposer,
  createRecurrenceOccurrenceResolver,
  createRecurrenceScopedMaterializer,
  createWorkCategoryResolver,
  type RecurrenceCensusScope,
  type RecurrenceOccurrenceComposer,
  type RecurrenceScopedMaterializer,
  type RecurrenceTools,
  type RecurrenceWriteScope,
} from '@workloom/domain';

import type { WorkloomTransaction } from '../client.js';
import { createPlanningCursorCodec } from '../planning/cursor.js';
import { createMeetingRepository } from '../repositories/meeting-repository.js';
import { createRecurrenceRepository } from '../repositories/recurrence-repository.js';
import { createWorkCategoryRepository } from '../repositories/work-category-repository.js';
import type { DbWorkspaceWriteScope } from '../transactions/workspace-write.js';
import { createRecurrenceCursorCodec } from './cursor.js';

/**
 * Shared recurrence composition for every real DB write factory (task, field, planning, category,
 * meeting, recurrence and the worker job). It binds the mandatory `recurrenceCensus` materializer to the
 * SAME open transaction, workspace barrier and serialized `scope.recordChange`; it never opens a
 * transaction, never calls a public write runner and has no optional no-op bypass. Factories import
 * this module, never each other, so there is no import cycle.
 */
export interface RecurrenceRuntime {
  readonly tools: RecurrenceTools;
  readonly composer: RecurrenceOccurrenceComposer;
}

export interface RecurrenceRuntimeOptions {
  /** HMAC key (≥32 bytes) shared by the planning list cursor and the materialization cursor codecs. */
  readonly cursorSecret?: string;
}

export type DbRecurrenceCensusScope = RecurrenceWriteScope &
  RecurrenceCensusScope & {
    /** The open transaction the whole composition is bound to. */
    readonly tx: WorkloomTransaction;
  };

/** Node crypto UUID/SHA-256, the existing planning cursor codec, the signed materialization cursor and the shared resolver.
 * Exactly one runtime per factory instance, so a materialization cursor decodes only where it was issued. */
export function createRecurrenceRuntime(options: RecurrenceRuntimeOptions = {}): RecurrenceRuntime {
  const secret = options.cursorSecret === undefined ? {} : { secret: options.cursorSecret };
  const planningCodec = createPlanningCursorCodec(secret);
  const materializationCodec = createRecurrenceCursorCodec(secret);
  const tools: RecurrenceTools = {
    newId: () => randomUUID(),
    digest: (value) => createHash('sha256').update(value, 'utf8').digest('hex'),
    encodeCursor: (value) => planningCodec.encode(value),
    decodeCursor: (token) => planningCodec.decode(token),
    // Runtime tz/ICU provenance is recorded on every resolution; a later upgrade never rewrites stored ones.
    resolver: createRecurrenceOccurrenceResolver({
      tzdataVersion: process.versions.tz || null,
      icuVersion: process.versions.icu || null,
    }),
    encodeMaterializationCursor: (value) => materializationCodec.encode(value),
    decodeMaterializationCursor: (token) => materializationCodec.decode(token),
  };
  return { tools, composer: createRecurrenceOccurrenceComposer(tools) };
}

/**
 * Builds the meeting/planning/category/recurrence scope and its census materializer on `scope.tx`. The
 * materializer captures THIS complete scope object, whose own `recurrenceCensus` is that same materializer, so
 * performFreeze reached from a final chunk sees the identical census and never builds a new scope or
 * transaction. The getter only guards the construction window: reading the census before the materializer
 * exists throws instead of returning undefined. Spreading the returned scope copies the initialized instance.
 */
export function composeRecurrenceCensusScope(scope: DbWorkspaceWriteScope, runtime: RecurrenceRuntime): DbRecurrenceCensusScope {
  const meetings = createMeetingRepository(scope.tx);
  const binding: { current: RecurrenceScopedMaterializer | undefined } = { current: undefined };
  const composed: DbRecurrenceCensusScope = {
    tx: scope.tx,
    context: scope.context,
    access: scope.access,
    barrierAt: scope.barrierAt,
    recordChange: scope.recordChange,
    repository: meetings.planning,
    statusTransitions:createTaskStatusTransitionPolicy(createDependencyRepository(scope.tx)),
    meetings,
    categoryResolver: createWorkCategoryResolver(createWorkCategoryRepository(scope.tx), scope.context.workspaceId),
    recurrence: createRecurrenceRepository(scope.tx, {
      planning: meetings.planning,
      source: scope.context.source,
      changedAt: scope.barrierAt,
    }),
    get recurrenceCensus(): RecurrenceScopedMaterializer {
      const census = binding.current;
      if (census === undefined) throw new Error('The recurrence census was read before its same-TX materializer was bound.');
      return census;
    },
  };
  binding.current = createRecurrenceScopedMaterializer(composed, runtime.tools, runtime.composer);
  return composed;
}
