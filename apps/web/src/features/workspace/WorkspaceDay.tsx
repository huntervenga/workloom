import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Temporal } from 'temporal-polyfill';

const WorkspaceDay = createContext<string | undefined>(undefined);

function calendarToday(timezone: string): string {
  try { return Temporal.Now.plainDateISO(timezone).toString(); }
  catch { return Temporal.Now.plainDateISO().toString(); }
}

export function WorkspaceDayProvider({ timezone, children }: { timezone: string; children: ReactNode }) {
  const [clock, setClock] = useState(() => ({ timezone, day: calendarToday(timezone) }));
  const today = clock.timezone === timezone ? clock.day : calendarToday(timezone);
  useEffect(() => {
    const update = () => {
      const day = calendarToday(timezone);
      setClock(previous => previous.timezone === timezone && previous.day === day ? previous : { timezone, day });
    };
    update();
    const timer = window.setInterval(update, 15_000);
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, [timezone]);
  return <WorkspaceDay.Provider value={today}>{children}</WorkspaceDay.Provider>;
}

export function useWorkspaceDay(): string {
  return useContext(WorkspaceDay) ?? Temporal.Now.plainDateISO().toString();
}
