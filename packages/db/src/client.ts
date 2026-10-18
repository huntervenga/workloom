import type { PgDatabase } from 'drizzle-orm/pg-core';
import { drizzle, type PostgresJsDatabase, type PostgresJsQueryResultHKT } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { parseDatabaseUrl, type DatabaseUrlInfo } from './database-url.js';
import {
  taskDependencies,projectDependencyPolicies,graphLayouts,graphLayoutPositions,
  meetings,meetingRevisions,meetingAttendances,meetingAttendanceRevisions,meetingScheduleLocks,
  recurrenceSeries,recurrenceSeriesVersions,recurrencePeriodBindings,recurrenceInstances,recurrenceExceptionVersions,recurrenceGenerationAuthorizations,recurrenceCalendarLocks,
  auditEvents,
  planningPeriods,
  projectWorkCategoryBindings,
  projectWorkCategoryBindingVersions,
  workTypeReportRuns,
  packageFreezeObservations,
  periodCommitments,
  commitmentAllocations,
  periodCommitmentRevisions,
  planBaselines,
  packageBaselines,
  planningLocks,
  workLogs,
  workLogRevisions,
  weeklyReportRuns,
  commandIdempotency,
  memberships,
  outboxEvents,
  projectColumnSettings,
  projectColumns,
  projects,
  sections,
  taskFieldDefinitionVersions,
  taskFieldDefinitions,
  taskFieldOptions,
  taskFieldValueHistory,
  taskFieldPolicies, taskFieldPolicyUsage,
  taskFieldValues,
  personalTablePreferences,
  planningCutoffAutomations, planningCutoffGrantVersions, planningCutoffRequests, planningCutoffDiscoveryState,
  taskComments,
  taskParticipants,
  taskStatuses,
  taskTags,
  tasks,
  users,
  sharedAuthIdentities, sharedAuthSessions, sharedAuthLoginAttempts,
  workspaceCreationReceipts, teamInvitations,
  workPackages,
  workspaceTags,
  workspaces,
} from './schema.js';

export const tables = {
  taskDependencies,projectDependencyPolicies,graphLayouts,graphLayoutPositions,
  meetings,meetingRevisions,meetingAttendances,meetingAttendanceRevisions,meetingScheduleLocks,
  recurrenceSeries,recurrenceSeriesVersions,recurrencePeriodBindings,recurrenceInstances,recurrenceExceptionVersions,recurrenceGenerationAuthorizations,recurrenceCalendarLocks,
  planningPeriods,
  projectWorkCategoryBindings,
  projectWorkCategoryBindingVersions,
  workTypeReportRuns,
  packageFreezeObservations,
  periodCommitments,
  commitmentAllocations,
  periodCommitmentRevisions,
  planBaselines,
  packageBaselines,
  planningLocks,
  workLogs,
  workLogRevisions,
  weeklyReportRuns,
  users,
  sharedAuthIdentities, sharedAuthSessions, sharedAuthLoginAttempts,
  workspaceCreationReceipts, teamInvitations,
  workspaces,
  memberships,
  auditEvents,
  outboxEvents,
  projects,
  sections,
  taskStatuses,
  workspaceTags,
  workPackages,
  tasks,
  personalTablePreferences,
  planningCutoffAutomations, planningCutoffGrantVersions, planningCutoffRequests, planningCutoffDiscoveryState,
  taskComments,
  taskParticipants,
  taskTags,
  commandIdempotency,
  taskFieldDefinitions,
  taskFieldDefinitionVersions,
  taskFieldOptions,
  projectColumnSettings,
  projectColumns,
  taskFieldPolicies, taskFieldPolicyUsage,
  taskFieldValues,
  taskFieldValueHistory,
};

export type WorkloomSchema = typeof tables;
export type WorkloomDb = PostgresJsDatabase<WorkloomSchema>;
export type WorkloomTransaction = Parameters<Parameters<WorkloomDb['transaction']>[0]>[0];
/** Common base of the pooled database and an open transaction. */
export type WorkloomExecutor = PgDatabase<PostgresJsQueryResultHKT, WorkloomSchema>;

export interface Database {
  /** Raw postgres.js client (pool). */
  readonly sql: postgres.Sql;
  /** Drizzle query builder over the same pool. */
  readonly db: WorkloomDb;
  /** Credential-free description of the target. */
  readonly info: DatabaseUrlInfo;
  /** Ends the pool. Idempotent. */
  close(): Promise<void>;
}

export interface CreateDatabaseOptions {
  readonly maxConnections?: number;
  readonly connectTimeoutSeconds?: number;
  readonly idleTimeoutSeconds?: number;
  readonly applicationName?: string;
  /** Reject non-loopback servers (local synthetic modes). */
  readonly requireLoopback?: boolean;
}

/**
 * Creates a lazily connecting pool. The URL is validated first so that a bad
 * value produces a DatabaseConfigError without echoing credentials.
 * Never runs migrations.
 */
export function createDatabase(url: string, options: CreateDatabaseOptions = {}): Database {
  const info = parseDatabaseUrl(url, { requireLoopback: options.requireLoopback ?? false });
  const sql = postgres(info.url, {
    max: options.maxConnections ?? 10,
    connect_timeout: options.connectTimeoutSeconds ?? 5,
    idle_timeout: options.idleTimeoutSeconds ?? 30,
    onnotice: () => undefined,
    connection: { application_name: options.applicationName ?? 'workloom' },
  });
  const db = drizzle(sql, { schema: tables });
  let closing: Promise<void> | undefined;
  return {
    sql,
    db,
    info,
    close() {
      closing ??= sql.end({ timeout: 5 });
      return closing;
    },
  };
}

export function isDatabase(value: unknown): value is Database {
  return (
    typeof value === 'object' &&
    value !== null &&
    'db' in value &&
    'sql' in value &&
    typeof (value as { close?: unknown }).close === 'function'
  );
}
