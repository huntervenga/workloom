import type { PersonalTablePreferenceDto } from '@workloom/contracts';
import type { AccessRepository } from '../access/ports.js';
import type { CommandContext } from '../access/context.js';
import type { Capability } from '../access/capabilities.js';
import type { IdempotencyRecord } from '../tasks/ports.js';
import type { WorkspaceWriteScope } from '../transactions/ports.js';
import type { PlanningMutationGuard } from '../planning/ports.js';
export interface PersonalTablePreferenceRepository {
  readonly access: AccessRepository;
  projectExists(workspaceId: string, projectId: string): Promise<boolean>;
  ownFieldIds(workspaceId: string, projectId: string, fieldIds: readonly string[]): Promise<string[]>;
  findPreference(workspaceId: string, projectId: string, membershipId: string): Promise<PersonalTablePreferenceDto | null>;
  savePreference(preference: PersonalTablePreferenceDto, updatedAt: string, exists: boolean): Promise<void>;
  findIdempotency(workspaceId: string, actorUserId: string, command: string, key: string): Promise<IdempotencyRecord | null>;
  insertIdempotency(receipt: IdempotencyRecord): Promise<void>;
}
export interface PersonalTablePreferenceWriteScope extends WorkspaceWriteScope { readonly repository: PersonalTablePreferenceRepository; readonly planningGuard: PlanningMutationGuard }
export interface PersonalTablePreferenceUnitOfWork {
  read<R>(work: (repository: PersonalTablePreferenceRepository) => Promise<R>): Promise<R>;
  run<R>(context: CommandContext, capability: Capability, work: (scope: PersonalTablePreferenceWriteScope) => Promise<R>): Promise<R>;
}
export interface PersonalTablePreferenceTools { digest(value: string): string }
