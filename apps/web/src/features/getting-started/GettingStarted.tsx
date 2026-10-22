import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Check, Circle, X } from 'lucide-react';
import type { MembershipDto } from '@workloom/contracts';
import { Button } from '@workloom/ui';
import { useTranslation } from '../../i18n';
import { WorkspaceLink as Link } from '../workspace/WorkspaceNavigation';
import { fetchApiTokens } from '../api-tokens/api';
import { useTimeOffOverview } from '../time-off/queries';

export interface ChecklistItem { key: 'team' | 'timeOff' | 'project' | 'tools'; done: boolean | null }

/** Which first steps are already done, from data the overview already has; `null` means unknown, never "not done". */
export function checklistState(input: { members: readonly MembershipDto[] | undefined; projectCount: number | undefined; timeOffConfigured: boolean | undefined; hasToken: boolean | undefined }): ChecklistItem[] {
  return [
    { key: 'team', done: input.members === undefined ? null : input.members.length > 1 },
    { key: 'timeOff', done: input.timeOffConfigured ?? null },
    { key: 'project', done: input.projectCount === undefined ? null : input.projectCount > 0 },
    { key: 'tools', done: input.hasToken ?? null },
  ];
}

const storageKey = (actorId: string, workspaceId: string) => `workloom.gettingStarted.${actorId}.${workspaceId}`;
function dismissedBefore(key: string): boolean { try { return window.localStorage.getItem(key) === 'done'; } catch { return false; } }
function remember(key: string) { try { window.localStorage.setItem(key, 'done'); } catch { /* the card simply returns next time */ } }

/** A short list of first steps for workspace managers; it disappears once finished or dismissed. */
export function GettingStarted({ actorId, workspaceId, members, projectCount }: { actorId: string; workspaceId: string; members: readonly MembershipDto[] | undefined; projectCount: number | undefined }) {
  const { t } = useTranslation();
  const key = storageKey(actorId, workspaceId);
  const [dismissed, setDismissed] = useState(() => dismissedBefore(key));
  const timeOff = useTimeOffOverview(actorId, workspaceId);
  const tokens = useQuery({ queryKey: ['getting-started-tokens', actorId], queryFn: ({ signal }) => fetchApiTokens(signal), retry: false, staleTime: 60_000 });
  const items = checklistState({
    members, projectCount,
    timeOffConfigured: timeOff.isSuccess ? timeOff.data.settings !== null : undefined,
    hasToken: tokens.isSuccess ? tokens.data.some(token => token.revokedAt === null && Date.parse(token.expiresAt) > Date.now()) : undefined,
  });
  const known = items.every(item => item.done !== null);
  if (dismissed || (known && items.every(item => item.done))) return null;
  const count = items.filter(item => item.done).length;
  const links = { team: 'members', timeOff: 'time-off', project: 'projects', tools: 'integrations' } as const;
  const names = { team: t('gettingStarted.team'), timeOff: t('gettingStarted.timeOff'), project: t('gettingStarted.project'), tools: t('gettingStarted.tools') } as const;
  const hints = { team: t('gettingStarted.teamHint'), timeOff: t('gettingStarted.timeOffHint'), project: t('gettingStarted.projectHint'), tools: t('gettingStarted.toolsHint') } as const;
  return <section aria-label={t('gettingStarted.title')} className="space-y-3 rounded-2xl border border-line bg-surface p-5">
    <div className="flex items-start justify-between gap-3">
      <div><h2 className="text-sm font-semibold text-ink">{t('gettingStarted.title')}</h2><p className="text-xs text-muted">{t('gettingStarted.progress', { done: count, total: items.length })}</p></div>
      <Button size="sm" variant="ghost" aria-label={t('gettingStarted.dismiss')} onClick={() => { remember(key); setDismissed(true); }}><X size={14} aria-hidden="true" /></Button>
    </div>
    <ul className="grid gap-2 sm:grid-cols-2">{items.map(item => <li key={item.key} data-step={item.key} data-done={item.done === true ? 'true' : 'false'}>
      <Link to={`/w/${workspaceId}/${links[item.key]}`} className="flex items-start gap-2 rounded-lg border border-line px-3 py-2 hover:bg-canvas">
        {item.done ? <Check size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-emerald-600" /> : <Circle size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-muted" />}
        <span className="min-w-0"><span className={`block text-sm font-medium ${item.done ? 'text-muted line-through' : 'text-ink'}`}>{names[item.key]}</span><span className="block text-xs text-muted">{hints[item.key]}</span></span>
      </Link>
    </li>)}</ul>
  </section>;
}
