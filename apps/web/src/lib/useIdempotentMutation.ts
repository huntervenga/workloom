import {
  useMutation,
  useQueryClient,
  type MutateOptions,
  type MutationFunctionContext,
  type UseMutationResult,
} from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { isUncertainOutcome, sendMutation, type MutationRequest } from './api';
import { IdempotencyKeyTracker, PendingCommandError } from './idempotency';
import { protectedCommandsFor, type ProtectedCommandEntry } from './protectedCommands';

export interface IdempotentVariables {
  /**
   * Key the caller already holds for this operation. When omitted, a key is
   * created at submission and reused while the same request is resubmitted.
   */
  idempotencyKey?: string | undefined;
}

export interface IdempotentMutationConfig<TVariables extends IdempotentVariables, TData> {
  /** Builds and validates the request; see `prepareMutation`. */
  prepare: (variables: TVariables) => MutationRequest<{ data: TData }>;
  onSuccess?: ((data: TData, variables: TVariables) => void) | undefined;
}

/** A sent write without a confirmed answer; the server may have applied it. */
export interface UncertainCommand<TVariables> {
  /** Exactly what was sent. Resending it reuses its Idempotency-Key. */
  variables: TVariables;
  error: Error;
}

/** The accepted command that is being sent, from `mutate` until its answer or failure. */
export interface PendingCommand<TVariables> {
  variables: TVariables;
}

/** `Omit` per union member, so status narrowing (`isSuccess` → `data`) keeps working. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type IdempotentMutateOptions<TData, TVariables> = MutateOptions<TData, Error, TVariables>;

export type IdempotentMutation<TData, TVariables> = DistributiveOmit<
  UseMutationResult<TData, Error, TVariables>,
  'mutate' | 'mutateAsync'
> & {
  /** Sends the command unless another one of this hook is in flight; see `pendingCommand`. */
  mutate: (variables: TVariables, options?: IdempotentMutateOptions<TData, TVariables>) => void;
  /** As `mutate`; rejects with `PendingCommandError` while another command is in flight. */
  mutateAsync: (variables: TVariables, options?: IdempotentMutateOptions<TData, TVariables>) => Promise<TData>;
  /**
   * Set after a network, server, unavailable or malformed-response failure, and kept through
   * `reset()`. Until a resend gets a confirmed answer, any different command fails with
   * `UncertainCommandError` without being sent.
   */
  uncertain: UncertainCommand<TVariables> | null;
  /** Resends the uncertain command unchanged, with its key. Only on an explicit user action. */
  retryUncertain: (options?: MutateOptions<TData, Error, TVariables>) => void;
  /**
   * The command in flight. While it is set, every other call, identical or not, fails with
   * `PendingCommandError` without being sent and without touching this command. Show pending
   * state from here rather than from `variables`, which `reset()` clears.
   */
  pendingCommand: PendingCommand<TVariables> | null;
  /**
   * Synchronous and stable: true while any other hook of this QueryClient holds a pending or uncertain
   * command. This hook's own command never counts; without a live registry slot (before mount, after
   * unmount) every protected command counts, including a possible own one.
   */
  hasOtherProtectedCommands: () => boolean;
};

const noop = () => undefined;

/**
 * A write with a stable Idempotency-Key. TanStack retries and offline pausing
 * are off: a failed write is only resent when the user submits it again, with
 * the same key.
 * One hook instance sends one command at a time and guards it until it is confirmed, so keep
 * it in a component that outlives the form (closing a dialog must not forget an uncertain
 * write). A pending or uncertain command is listed in the QueryClient's protected commands,
 * so leaving the page asks first.
 */
export function useIdempotentMutation<TVariables extends IdempotentVariables, TData>({
  prepare,
  onSuccess,
}: IdempotentMutationConfig<TVariables, TData>): IdempotentMutation<TData, TVariables> {
  const queryClient = useQueryClient();
  const registry = protectedCommandsFor(queryClient);
  const [tracker] = useState(() => new IdempotencyKeyTracker());
  const [uncertain, setUncertain] = useState<UncertainCommand<TVariables> | null>(null);
  const [pendingCommand, setPendingCommand] = useState<PendingCommand<TVariables> | null>(null);
  // Refs answer synchronously, before React re-renders: a second click in the same tick is refused.
  const inFlight = useRef<PendingCommand<TVariables> | null>(null);
  const held = useRef<UncertainCommand<TVariables> | null>(null);
  const entry = useRef<ProtectedCommandEntry | null>(null);

  const publish = useCallback(() => entry.current?.set(inFlight.current !== null || held.current !== null), []);
  const hold = (next: UncertainCommand<TVariables> | null) => {
    held.current = next;
    setUncertain(next);
    publish();
  };

  useEffect(() => {
    const current = registry.register();
    entry.current = current;
    publish();
    return () => {
      current.dispose();
      if (entry.current === current) entry.current = null;
    };
  }, [registry, publish]);

  const mutation = useMutation<TData, Error, TVariables>({
    retry: false,
    // The default 'online' mode pauses an offline write and sends it by itself
    // on reconnect, possibly under another actor. A write is sent once, now; a
    // failure becomes an uncertain command that only the user resends.
    networkMode: 'always',
    mutationFn: async (variables) => {
      const request = prepare(variables);
      // Refuses, without sending, anything but the uncertain command itself.
      const idempotencyKey = tracker.keyFor(request.fingerprint, variables.idempotencyKey);
      try {
        const response = await sendMutation(request, { idempotencyKey });
        tracker.complete(request.fingerprint);
        hold(null);
        return response.data;
      } catch (error) {
        if (isUncertainOutcome(error)) {
          tracker.fail(request.fingerprint, true);
          hold({ variables, error });
        } else {
          tracker.fail(request.fingerprint, false);
          hold(null);
        }
        throw error;
      }
    },
    onSuccess: (data, variables) => onSuccess?.(data, variables),
  });

  const { mutateAsync: execute } = mutation;
  // Guards before TanStack sees the call: a refused call must not replace the observed
  // mutation, its variables or the tracker's key.
  const mutateAsync = useCallback(
    (variables: TVariables, options?: MutateOptions<TData, Error, TVariables>): Promise<TData> => {
      if (inFlight.current !== null) {
        const error = new PendingCommandError();
        const context: MutationFunctionContext = { client: queryClient, meta: undefined };
        options?.onError?.(error, variables, undefined, context);
        options?.onSettled?.(undefined, error, variables, undefined, context);
        return Promise.reject(error);
      }
      const command = { variables };
      inFlight.current = command;
      setPendingCommand(command);
      publish();
      return execute(variables, options).finally(() => {
        if (inFlight.current !== command) return;
        inFlight.current = null;
        setPendingCommand(null);
        publish();
      });
    },
    [execute, publish, queryClient],
  );
  const mutate = useCallback(
    (variables: TVariables, options?: MutateOptions<TData, Error, TVariables>) => {
      mutateAsync(variables, options).catch(noop);
    },
    [mutateAsync],
  );

  const retryUncertain = useCallback(
    (options?: MutateOptions<TData, Error, TVariables>) => {
      if (held.current) mutate(held.current.variables, options);
    },
    [mutate],
  );

  const hasOtherProtectedCommands = useCallback(
    () => (entry.current ? entry.current.hasOthers() : registry.protecting),
    [registry],
  );

  return { ...mutation, mutate, mutateAsync, uncertain, retryUncertain, pendingCommand, hasOtherProtectedCommands };
}
