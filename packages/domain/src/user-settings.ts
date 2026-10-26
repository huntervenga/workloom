import { updateUserSettingsInputSchema, type UpdateUserSettingsInput, type UserSettingsDto } from '@workloom/contracts';
import type { ActorContext } from './access/context.js';
import { DomainError, unauthenticatedError } from './errors.js';

export interface UserSettingsRepository {
  /** Inside a write, locks the user row so concurrent first saves serialize too. */
  userExists(userId: string): Promise<boolean>;
  get(userId: string): Promise<UserSettingsDto | null>;
  put(value: UserSettingsDto): Promise<void>;
}
export interface UserSettingsUnitOfWork {
  read<T>(work: (repository: UserSettingsRepository) => Promise<T>): Promise<T>;
  write<T>(work: (repository: UserSettingsRepository) => Promise<T>): Promise<T>;
}
export interface UserSettingsApplication {
  get(context: ActorContext): Promise<UserSettingsDto>;
  update(context: ActorContext, input: UpdateUserSettingsInput): Promise<UserSettingsDto>;
}

/** Account preferences have no workspace/domain-data side effects and can address only the actor. */
export function createUserSettingsService(unit: UserSettingsUnitOfWork, now = () => new Date()): UserSettingsApplication {
  const current = async (repository: UserSettingsRepository, context: ActorContext) => {
    const userId = context.actor.userId.toLowerCase();
    if (!await repository.userExists(userId)) throw unauthenticatedError();
    return await repository.get(userId) ?? { userId, revision: 0, settings: { version: 1 as const, theme: 'default' as const }, updatedAt: null };
  };
  return {
    get: context => unit.read(repository => current(repository, context)),
    update: (context, input) => unit.write(async repository => {
      const before = await current(repository, context);
      const parsed = updateUserSettingsInputSchema.safeParse(input);
      if (!parsed.success) throw new DomainError('VALIDATION_FAILED', 'Invalid user settings.');
      if (parsed.data.expectedUserId !== before.userId) throw unauthenticatedError();
      if (before.revision !== parsed.data.expectedRevision) throw new DomainError('REVISION_CONFLICT', 'Your settings changed. Reload them before saving.');
      if (before.settings.theme === parsed.data.settings.theme) return before;
      const next: UserSettingsDto = { ...before, revision: before.revision + 1, settings: { ...before.settings, ...parsed.data.settings }, updatedAt: now().toISOString() };
      await repository.put(next);
      return next;
    }),
  };
}
