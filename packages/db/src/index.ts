export {
  createDatabase,
  isDatabase,
  tables,
  type CreateDatabaseOptions,
  type Database,
  type WorkloomDb,
  type WorkloomExecutor,
  type WorkloomSchema,
  type WorkloomTransaction,
} from './client.js';
export {
  DatabaseConfigError,
  isLoopbackHost,
  parseDatabaseUrl,
  type DatabaseUrlInfo,
  type ParseDatabaseUrlOptions,
} from './database-url.js';
export {
  databaseErrorCode,
  describeErrorForLog,
  isDatabaseUnavailableError,
  type LoggableError,
} from './database-errors.js';
export {
  UnsafeEnvironmentError,
  assertLocalSyntheticEnvironment,
  findRailwayMarkers,
  loadEnvFileIfPresent,
  type EnvironmentSource,
} from './env-guard.js';
export {
  MIGRATIONS_FOLDER,
  MIGRATIONS_SCHEMA,
  MIGRATIONS_TABLE,
  MigrationStateError,
  inspectMigrationState,
  readExpectedMigrations,
  runMigrations,
  type ExpectedMigration,
  type MigrationRunResult,
  type MigrationState,
  type MigrationStatus,
  type RunMigrationsOptions,
} from './migrations.js';
export {
  createReadinessProbe,
  type ReadinessCheckResult,
  type ReadinessProbe,
  type ReadinessProbeOptions,
  type ReadinessReport,
} from './readiness.js';
export { createAccessRepository } from './repositories/access-repository.js';
export { createTaskRepository } from './repositories/task-repository.js';
export { createTaskFieldRepository } from './repositories/task-field-repository.js';
export { createTaskFieldApplication, type TaskFieldApplicationOptions } from './fields/task-field-application.js';
export {
  createTaskFieldHistoryCursorCodec,
  type TaskFieldHistoryCursorCodec,
  type TaskFieldHistoryCursorCodecOptions,
} from './fields/history-cursor.js';
export { createTaskApplication, type TaskApplicationOptions } from './tasks/task-application.js';
export {
  createWorkspaceWriteRunner,
  runWorkspaceWrite,
  type DbWorkspaceWriteScope,
  type WorkspaceWriteOptions,
} from './transactions/workspace-write.js';
export { seedDemoData, type DemoSeedResult, type SeedTableResult } from './seed/demo-seed.js';
export * from './fixtures.js';
export * as schema from './schema.js';
export { REQUIRED_TABLES } from './schema.js';

export { createPlanningApplication, type PlanningApplicationOptions } from './planning/planning-application.js';
export { createPlanningRepository } from './repositories/planning-repository.js';
export { createPlanningCursorCodec, type PlanningCursorCodec, type PlanningCursorCodecOptions } from './planning/cursor.js';
export { createWorkCategoryApplication, type WorkCategoryApplicationOptions } from './categories/work-category-application.js';
export { createWorkCategoryRepository } from './repositories/work-category-repository.js';
