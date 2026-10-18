import type { Database } from '@workloom/db';
export interface DemoState { version: 1; workspaceId: string; ownerUserId: string; fixtureSHA: string; commands: Record<string, unknown>; complete?: { projectId: string; periodId: string; runId: string; typeRunId: string; verifiedChecks: number; at: string }; }
export const FIXTURE_SHA: string;
export function applyWeeklyDemo(input: { db: Database; workspaceId: string; ownerUserId: string; state: DemoState; persist: () => Promise<void> }): Promise<{ complete: NonNullable<DemoState['complete']>; checks: { passed: number; failed: number } }>;
export function stableDemoId(workspaceId: string, label: string): string;
export function preserveOriginalRows(db: Database, workspaceId: string, prior?: Record<string, Record<string, string>>): Promise<Record<string, Record<string, string>>>;
