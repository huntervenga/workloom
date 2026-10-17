import { useQueryClient, type Query, type QueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { useNavigate } from 'react-router';
import { loginHref, logoutSession } from '../features/auth/authApi';
import { protectedDraftsFor } from '../lib/protectedDrafts';
import { protectedCommandsFor } from '../lib/protectedCommands';

/** A shared sign-in action waiting for the user to confirm discarding pending or unsaved work. */
export type SessionAction = 'signIn' | 'signOut';

export interface SessionContextValue {
  switching: boolean;
  switchError: unknown;
  dismissSwitchError: () => void;
  /**
   * Runs `changeSession` with every trace of the previous actor hidden and discarded. While a
   * write is pending or uncertain, the mounted navigation guard asks first; declining does nothing.
   */
  switchActor: (changeSession: () => Promise<void>) => Promise<void>;
  /** True while an accepted logout request has not been answered yet. */
  signingOut: boolean;
  /** Set when logout was not confirmed; the session may or may not have ended. */
  logoutError: unknown;
  /**
   * Asks the server to end the shared session once. Everything stays mounted until the server
   * confirms; only then is the previous actor unmounted and forgotten.
   */
  signOut: () => Promise<void>;
  /** Leaves the app for the shared sign-in page, after the guard asks when work would be lost. */
  startSignIn: (returnTo: string) => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);
const SessionActionContext = createContext<SessionAction | null>(null);

// The dev actor list is not tied to the current actor; everything else is.
const isSessionScoped = (query: Query) => query.queryKey[0] !== 'dev';

async function discardSessionData(queryClient: QueryClient): Promise<void> {
  await queryClient.cancelQueries({ predicate: isSessionScoped });
  queryClient.removeQueries({ predicate: isSessionScoped });
  // Recorded writes belong to the actor that sent them.
  queryClient.getMutationCache().clear();
}

const assignLocation = (href: string) => window.location.assign(href);

export function SessionProvider({
  children,
  assignDocument = assignLocation,
}: {
  children: ReactNode;
  /** Full-tab navigation; tests replace it because JSDOM does not navigate. */
  assignDocument?: (href: string) => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<unknown>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [logoutError, setLogoutError] = useState<unknown>(null);
  const [pendingAction, setPendingAction] = useState<SessionAction | null>(null);
  const inFlight = useRef(false);

  const switchActor = useCallback(
    async (changeSession: () => Promise<void>) => {
      if (inFlight.current) return;
      inFlight.current = true;
      // Switching discards writes still being sent or with an unknown outcome; the user decides first.
      const commands = protectedCommandsFor(queryClient);
      const drafts=protectedDraftsFor(queryClient);
      if (commands.protecting || drafts.protecting) {
        let leave = false;
        try {
          leave = await (commands.protecting ? commands.confirmDeparture() : drafts.confirmDeparture());
        } finally {
          if (!leave) inFlight.current = false;
        }
        if (!leave) return;
      }
      commands.clear();
      drafts.clear();
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

  /** Resolves true when nothing is at stake or the user chose to leave it behind. */
  const confirmAuthAction = useCallback(
    async (action: SessionAction): Promise<boolean> => {
      const commands = protectedCommandsFor(queryClient);
      const drafts = protectedDraftsFor(queryClient);
      if (!commands.protecting && !drafts.protecting) return true;
      setPendingAction(action);
      try {
        return await (commands.protecting ? commands.confirmDeparture() : drafts.confirmDeparture());
      } finally {
        setPendingAction(null);
      }
    },
    [queryClient],
  );

  const signOut = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      if (!(await confirmAuthAction('signOut'))) return;
      setLogoutError(null);
      setSigningOut(true);
      try {
        await logoutSession();
      } catch (error) {
        // Not confirmed: the server may still have ended the session. Keep every screen, draft
        // and command as they are until the user retries or the server reports no session.
        setLogoutError(error);
        setSigningOut(false);
        return;
      }
      // Confirmed. Unmount every screen of the previous actor, then forget it. signingOut stays
      // set through the cleanup so the switching screen reads as signing out, not as a dev switch.
      flushSync(() => {
        setSwitching(true);
      });
      try {
        protectedCommandsFor(queryClient).clear();
        protectedDraftsFor(queryClient).clear();
        await discardSessionData(queryClient);
      } finally {
        navigate('/', { replace: true });
        setSwitching(false);
        setSigningOut(false);
      }
    } finally {
      inFlight.current = false;
    }
  }, [confirmAuthAction, navigate, queryClient]);

  const startSignIn = useCallback(
    async (returnTo: string) => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const commands = protectedCommandsFor(queryClient);
        const drafts = protectedDraftsFor(queryClient);
        const asked = commands.protecting || drafts.protecting;
        if (!(await confirmAuthAction('signIn'))) return;
        if (asked) {
          // The user already agreed to leave this work; do not ask again on unload.
          commands.clear();
          drafts.clear();
        }
        assignDocument(loginHref(returnTo));
      } finally {
        inFlight.current = false;
      }
    },
    [assignDocument, confirmAuthAction, queryClient],
  );

  const value = useMemo<SessionContextValue>(
    () => ({
      switching,
      switchError,
      dismissSwitchError: () => setSwitchError(null),
      switchActor,
      signingOut,
      logoutError,
      signOut,
      startSignIn,
    }),
    [switching, switchError, switchActor, signingOut, logoutError, signOut, startSignIn],
  );

  return (
    <SessionContext.Provider value={value}>
      <SessionActionContext.Provider value={pendingAction}>{children}</SessionActionContext.Provider>
    </SessionContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession must be used inside SessionProvider');
  return session;
}

/** The session, or null where no SessionProvider is mounted. */
export function useOptionalSession(): SessionContextValue | null {
  return useContext(SessionContext);
}

/** The sign-in action awaiting confirmation, or null (also outside SessionProvider). */
export function useSessionAction(): SessionAction | null {
  return useContext(SessionActionContext);
}
