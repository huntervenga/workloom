import { changeUserAvatarInputSchema, idSchema, safeProfilePhotoUrl, uploadedAvatarUrl, type ChangeUserAvatarInput, type UserAvatarDto } from '@workloom/contracts';
import type { ActorContext } from './access/context.js';
import { DomainError, notFoundError, unauthenticatedError } from './errors.js';

export interface AvatarRecord {
  id: string; userId: string; expectedRevision: number; storageId: string; objectKey: string;
  versionId: string | null; state: 'pending' | 'ready' | 'retired'; writeDeadline: string;
}
export interface AvatarUser { id: string; avatarId: string | null; avatarRevision: number; avatarUrl: string | null }
export interface UserAvatarRepository {
  user(userId: string): Promise<AvatarUser | null>;
  find(id: string): Promise<AvatarRecord | null>;
  canRead(viewerId: string, userId: string): Promise<boolean>;
  insert(row: AvatarRecord): Promise<void>;
  activate(user: AvatarUser, row: AvatarRecord): Promise<void>;
  remove(user: AvatarUser): Promise<void>;
}
export interface UserAvatarUnitOfWork {
  read<T>(work: (repository: UserAvatarRepository) => Promise<T>): Promise<T>;
  write<T>(userId: string, work: (repository: UserAvatarRepository, now: Date) => Promise<T>): Promise<T>;
}
const conflict = () => new DomainError('REVISION_CONFLICT', 'Your avatar changed. Reload your profile and try again.');
function actor(context: ActorContext): string {
  const id = idSchema.safeParse(context.actor?.userId);
  if (!id.success) throw unauthenticatedError(); return id.data;
}
function inputFor(context: ActorContext, input: ChangeUserAvatarInput) {
  const value = changeUserAvatarInputSchema.safeParse(input);
  if (!value.success) throw new DomainError('VALIDATION_FAILED', 'The avatar input is invalid.');
  if (actor(context) !== value.data.expectedUserId) throw unauthenticatedError();
  return value.data;
}
const found = <T>(value: T | null): T => { if (value === null) throw notFoundError(); return value; };
function dto(user: AvatarUser): UserAvatarDto {
  return { userId: user.id, revision: user.avatarRevision, hasCustomAvatar: user.avatarId !== null,
    avatarUrl: user.avatarId ? uploadedAvatarUrl(user.id, user.avatarId) : safeProfilePhotoUrl(user.avatarUrl) };
}
export function createUserAvatarService(unit: UserAvatarUnitOfWork, newId: () => string) {
  return {
    async get(context: ActorContext): Promise<UserAvatarDto> {
      const id = actor(context); return unit.read(async repo => dto(found(await repo.user(id))));
    },
    async prepare(context: ActorContext, input: ChangeUserAvatarInput, storageId: string): Promise<AvatarRecord> {
      const { expectedUserId: userId, expectedRevision } = inputFor(context, input);
      return unit.write(userId, async (repo, now) => {
        const user = found(await repo.user(userId));
        if (user.avatarRevision !== expectedRevision) throw conflict();
        const id = newId(), row: AvatarRecord = { id, userId, expectedRevision, storageId, objectKey: `avatars/${userId}/${id}.webp`,
          state: 'pending', versionId: null, writeDeadline: new Date(now.getTime() + 5 * 60_000).toISOString() };
        await repo.insert(row); return row;
      });
    },
    async finish(context: ActorContext, original: AvatarRecord, versionId: string | null): Promise<UserAvatarDto> {
      const userId = actor(context);
      if (original.userId !== userId) throw unauthenticatedError();
      return unit.write(userId, async (repo, now) => {
        const user = found(await repo.user(userId)), row = found(await repo.find(original.id));
        if (row.userId !== userId || row.objectKey !== original.objectKey || row.storageId !== original.storageId) throw notFoundError();
        if (row.state !== 'pending' || user.avatarRevision !== row.expectedRevision || Date.parse(row.writeDeadline) <= now.getTime()) throw conflict();
        await repo.activate(user, { ...row, versionId, state: 'ready' });
        return dto({ ...user, avatarId: row.id, avatarRevision: user.avatarRevision + 1 });
      });
    },
    async remove(context: ActorContext, input: ChangeUserAvatarInput): Promise<UserAvatarDto> {
      const { expectedUserId: userId, expectedRevision } = inputFor(context, input);
      return unit.write(userId, async repo => {
        const user = found(await repo.user(userId));
        if (user.avatarRevision !== expectedRevision) throw conflict();
        if (user.avatarId === null) return dto(user);
        await repo.remove(user);
        return dto({ ...user, avatarId: null, avatarRevision: user.avatarRevision + 1 });
      });
    },
    async download(context: ActorContext, rawUserId: string, rawAvatarId: string): Promise<AvatarRecord> {
      const viewerId = actor(context), userId = idSchema.safeParse(rawUserId), avatarId = idSchema.safeParse(rawAvatarId);
      if (!userId.success || !avatarId.success) throw notFoundError();
      return unit.read(async repo => {
        if (viewerId !== userId.data && !await repo.canRead(viewerId, userId.data)) throw notFoundError();
        const user = found(await repo.user(userId.data));
        if (user.avatarId !== avatarId.data) throw notFoundError();
        const row = found(await repo.find(avatarId.data));
        if (row.state !== 'ready' || row.userId !== user.id) throw notFoundError();
        return row;
      });
    },
  };
}
export type UserAvatarApplication = ReturnType<typeof createUserAvatarService>;
