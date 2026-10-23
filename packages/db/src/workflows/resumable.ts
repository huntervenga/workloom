import { createHash } from 'node:crypto';
import { DomainError, type Capability, type CommandContext } from '@workloom/domain';
import type { Database, WorkloomExecutor } from '../client.js';
import { createTaskRepository } from '../repositories/task-repository.js';
import { createWorkspaceWriteRunner, type DbWorkspaceWriteScope } from '../transactions/workspace-write.js';

/**
 * Bind a multi-command workflow to its complete input before any proposed command, then retain its exact final ACK.
 * Steps keep their own transactions: a mandatory planning freeze remains committed if a later step is rejected.
 * This is resumable, not all-or-nothing; unfinished operations retain the claim for a retry with the original input.
 */
export async function resumableWorkflow<T>(source: Database | WorkloomExecutor, context: CommandContext, options: {
  command: string;
  capability: Capability;
  input: unknown;
  schema: {
    parse(value: unknown): T;
  };
  authorize(scope: DbWorkspaceWriteScope): Promise<void>;
  work(): Promise<T>;
}): Promise<T> {
  const key = context.idempotencyKey;
  if (!key || !/^[\x21-\x7e]{1,128}$/.test(key))
    throw new DomainError('VALIDATION_FAILED', 'A valid Idempotency-Key is required.');
  const hash = createHash('sha256').update(JSON.stringify(options.input)).digest('hex');
  const writer = createWorkspaceWriteRunner(source);
  const mismatch = () => new DomainError('IDEMPOTENCY_KEY_REUSED', 'This operation key belongs to a different workflow request.');
  const initial = await writer.run(context, options.capability, async (scope) => {
    await options.authorize(scope);
    const repo = createTaskRepository(scope.tx);
    const ws = context.workspaceId;
    const actor = context.actor.userId;
    const outcome = await repo.findIdempotency(ws, actor, options.command, key);
    if (outcome) {
      if (outcome.payloadHash !== hash)
        throw mismatch();
      return { done: true as const, value: options.schema.parse(outcome.result) };
    }
    const claim = await repo.findIdempotency(ws, actor, options.command + '.request', key);
    if (claim) {
      if (claim.payloadHash !== hash)
        throw mismatch();
    }
    else
      await repo.insertIdempotency({
        workspaceId: ws, actorUserId: actor, command: options.command + '.request',
        idempotencyKey: key, payloadHash: hash, result: { started: true },
        createdAt: scope.barrierAt.toISOString(),
      });
    return { done: false as const };
  });
  if (initial.done)
    return initial.value;
  const value = options.schema.parse(await options.work());
  return writer.run(context, options.capability, async (scope) => {
    await options.authorize(scope);
    const repo = createTaskRepository(scope.tx);
    const ws = context.workspaceId;
    const actor = context.actor.userId;
    const outcome = await repo.findIdempotency(ws, actor, options.command, key);
    if (outcome) {
      if (outcome.payloadHash !== hash)
        throw mismatch();
      return options.schema.parse(outcome.result);
    }
    await repo.insertIdempotency({
      workspaceId: ws, actorUserId: actor, command: options.command,
      idempotencyKey: key, payloadHash: hash, result: value,
      createdAt: scope.barrierAt.toISOString(),
    });
    return value;
  });
}
