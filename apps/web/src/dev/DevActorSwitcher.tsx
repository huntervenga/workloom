import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useQuery } from '@tanstack/react-query';
import { devActorListResponseSchema, meResponseSchema } from '@workloom/contracts';
import { Avatar, Button } from '@workloom/ui';
import { Check, ChevronsUpDown } from 'lucide-react';
import { useSession } from '../app/session';
import { ApiError, apiGet, apiRequest } from '../lib/api';
import { queryKeys } from '../lib/queryKeys';

/**
 * Local development only. Loaded via a dynamic import guarded by
 * import.meta.env.DEV, so it never ships in optimized builds. The server owns
 * the allowlist and the session cookie; this UI only offers actors the server
 * listed and never sends identity headers on regular requests.
 */

async function startDevSession(actorId: string): Promise<void> {
  const { status, payload } = await apiRequest('/api/v1/dev/session', {
    method: 'POST',
    body: { actorId },
    headers: { 'x-workloom-dev-tool': '1' },
  });
  // The switch flow refetches /me itself; the body is only checked against the contract.
  if (!meResponseSchema.safeParse(payload).success) {
    throw new ApiError({ kind: 'invalid_response', status });
  }
}

export default function DevActorSwitcher({ currentActorId }: { currentActorId: string }) {
  const { switchActor } = useSession();
  const actors = useQuery({
    queryKey: queryKeys.devActors,
    queryFn: async ({ signal }) => (await apiGet('/api/v1/dev/actors', devActorListResponseSchema, signal)).data,
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  // Without a working dev endpoint there is nothing to offer.
  if (!actors.isSuccess || actors.data.length === 0) return null;
  const allowedIds = new Set(actors.data.map((actor) => actor.id));

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button variant="ghost" size="sm" className="mt-2 w-full justify-between text-amber-900 hover:bg-amber-100/70 hover:text-amber-950">
          Сменить пользователя
          <ChevronsUpDown size={16} aria-hidden="true" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          className="z-50 max-h-[var(--radix-dropdown-menu-content-available-height)] w-64 max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-xl border border-line bg-surface p-1.5 shadow-lg shadow-slate-900/5"
        >
          <DropdownMenu.Label className="px-2 pt-1 pb-1.5 text-[11px] font-semibold tracking-[0.08em] text-subtle uppercase">
            Тестовые пользователи
          </DropdownMenu.Label>
          <DropdownMenu.RadioGroup
            value={currentActorId}
            onValueChange={(actorId) => {
              if (actorId === currentActorId || !allowedIds.has(actorId)) return;
              void switchActor(() => startDevSession(actorId));
            }}
          >
            {actors.data.map((actor) => (
              <DropdownMenu.RadioItem
                key={actor.id}
                value={actor.id}
                className="flex cursor-default items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm outline-none select-none data-[highlighted]:bg-slate-100"
              >
                <Avatar name={actor.displayName} seed={actor.id} size="sm" />
                <span className="min-w-0 flex-1 truncate text-ink">{actor.displayName}</span>
                <DropdownMenu.ItemIndicator>
                  <Check size={16} aria-hidden="true" className="text-accent" />
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
          <p className="px-2 pt-2 pb-1 text-[11px] leading-snug text-subtle">Доступно только при локальной разработке.</p>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
