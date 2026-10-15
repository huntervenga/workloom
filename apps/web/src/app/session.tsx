import { useQueryClient, type Query, type QueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { useNavigate } from 'react-router';
import { protectedCommandsFor } from '../lib/protectedCommands';

export interface SessionContextValue {
  switching: boolean;
  switchError: unknown;
  dismissSwitchError: () => void;
  /**
   * Runs `changeSession` with every trace of the previous actor hidden and discarded. While a
   * write is pending or uncertain, the mounted navigation guard asks first; declining does nothing.
   */
  switchActor: (changeSession: () => Promise<void>) => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

// The dev actor list is not tied to the current actor; everything else is.
const isSessionScoped = (query: Query) => query.queryKey[0] !== 'dev';

async function discardSessionData(queryClient: QueryClient): Promise<void> {
  await queryClient.cancelQueries({ predicate: isSessionScoped });
  queryClient.removeQueries({ predicate: isSessionScoped });
  // Recorded writes belong to the actor that sent them.
  queryClient.getMutationCache().clear();
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<unknown>(null);
  const inFlight = useRef(false);

  const switchActor = useCallback(
    async (changeSession: () => Promise<void>) => {
      if (inFlight.current) return;
      inFlight.current = true;
      // Switching discards writes still being sent or with an unknown outcome; the user decides first.
      const commands = protectedCommandsFor(queryClient);
      if (commands.protecting) {
        let leave = false;
        try {
          leave = await commands.confirmDeparture();
        } finally {
          if (!leave) inFlight.current = false;
        }
        if (!leave) return;
      }
      commands.clear();
      // Unmount every screen showing the previous actor before any network work.
      flushSync(() => {
        setSwitchError(null);
        setSwitching(true);
      });
      try {
        await discardSessionData(queryClient);
        await changeSession();
      } catch (error) {
        setSwitchError(error);
      } finally {
        // Whatever happened, the server now decides the actor: start clean at the root.
        await discardSessionData(queryClient);
        navigate('/', { replace: true });
        inFlight.current = false;
        setSwitching(false);
      }
    },
    [navigate, queryClient],
  );

  const value = useMemo<SessionContextValue>(
    () => ({ switching, switchError, dismissSwitchError: () => setSwitchError(null), switchActor }),
    [switching, switchError, switchActor],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession must be used inside SessionProvider');
  return session;
}
