import { useQuery, useQueryClient } from '@tanstack/react-query';
import { meResponseSchema, type MeDto } from '@workloom/contracts';
import { createContext, useContext, type ReactNode } from 'react';
import { apiGet } from '../../lib/api';
import { queryKeys } from '../../lib/queryKeys';

export function useMeQuery() {
  const client = useQueryClient();
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: async ({ signal }) => {
      const data = (await apiGet('/api/v1/me', meResponseSchema, signal)).data;
      const current = client.getQueryData<MeDto>(queryKeys.me);
      // A read started before a confirmed save cannot roll back the current account's theme.
      if (current?.actor.id === data.actor.id && current.settings && data.settings && current.settings.revision > data.settings.revision) return { ...data, settings: current.settings };
      return data;
    },
  });
}

const MeContext = createContext<MeDto | null>(null);

export function MeProvider({ me, children }: { me: MeDto; children: ReactNode }) {
  return <MeContext.Provider value={me}>{children}</MeContext.Provider>;
}

/** The server-resolved identity; only available inside the loaded shell. */
export function useMe(): MeDto {
  const me = useContext(MeContext);
  if (!me) throw new Error('useMe must be used inside MeProvider');
  return me;
}
