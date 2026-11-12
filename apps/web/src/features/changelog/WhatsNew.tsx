import { Badge, Button, buttonClassName } from '@workloom/ui';
import { Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router';
import { formatDate, t, useTranslation } from '../../i18n';
import { useDocumentTitle } from '../../lib/useDocumentTitle';
import { useMe } from '../identity/identity';
import { WorkspaceLink as Link } from '../workspace/WorkspaceNavigation';
import { CHANGELOG, changelogMarker, dismissChangelogNote, markChangelogSeen, newDays, readChangelogSeen, useChangelogState, type Changelog } from './changelog';

/** Workspace route of the page; the log itself is the same in every workspace. */
export const WHATS_NEW_PATH = 'whats-new';

/** The whole log, newest day first. Opening it marks everything seen; what was new keeps its badge while the page is open. */
export function WhatsNewPage({ log = CHANGELOG }: { log?: Changelog }) {
  useTranslation();
  const actorId = useMe().actor.id;
  const [fresh] = useState(() => new Set(newDays(log, readChangelogSeen(actorId)).map(day => day.date)));
  useEffect(() => { markChangelogSeen(actorId, changelogMarker(log)); }, [actorId, log]);
  useDocumentTitle(t('whatsNew.title'));
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <header>
        <h1 className="text-2xl font-semibold text-ink">{t('whatsNew.title')}</h1>
        <p className="mt-1 text-sm text-muted">{t('whatsNew.description')}</p>
      </header>
      {log.days.map(day => (
        <section key={day.date} aria-labelledby={`whats-new-${day.date}`} className="space-y-2 rounded-xl border border-line bg-surface p-4">
          <h2 id={`whats-new-${day.date}`} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-base font-semibold text-ink">
            <span>{formatDate(day.date, { day: 'numeric', month: 'long', year: 'numeric' })}</span>
            {day.title ? <span className="font-medium text-ink-soft">{day.title}</span> : null}
            {fresh.has(day.date) ? <Badge tone="accent">{t('whatsNew.new')}</Badge> : null}
          </h2>
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-ink-soft">
            {day.items.map(item => <li key={item}>{item}</li>)}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** Dot after the sidebar entry while the newest entry has not been shown on the page. */
export function WhatsNewDot({ actorId }: { actorId: string }) {
  useTranslation();
  if (!useChangelogState(actorId).unseen) return null;
  // Labelled like the Inbox badge: announced with the entry, without counting as an image.
  return <span aria-label={t('whatsNew.unseen')} className="ml-auto size-2 shrink-0 rounded-full bg-accent" />;
}

/**
 * A small note in the corner offering to open the log when something new arrived: the sidebar dot
 * alone is easy to miss. "Not now" hides it until the next entry; opening the page clears it.
 */
export function WhatsNewNote({ actorId, workspaceId, log = CHANGELOG }: { actorId: string; workspaceId: string; log?: Changelog }) {
  useTranslation();
  const state = useChangelogState(actorId, log);
  const location = useLocation();
  const newest = log.days[0];
  if (!state.note || !newest || location.pathname.endsWith(`/${WHATS_NEW_PATH}`)) return null;
  return (
    <section aria-label={t('whatsNew.noteLabel')} className="fixed right-5 bottom-5 z-[80] w-[min(22rem,calc(100vw-2.5rem))] rounded-xl border border-line bg-surface p-4 text-sm shadow-lg">
      <p className="flex items-center gap-2 font-semibold text-ink"><Sparkles size={16} aria-hidden="true" className="shrink-0 text-accent" />{t('whatsNew.noteTitle')}</p>
      <p className="mt-1 line-clamp-3 text-ink-soft">{newest.items[0]}</p>
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <Button size="sm" onClick={() => dismissChangelogNote(actorId, changelogMarker(log))}>{t('whatsNew.notNow')}</Button>
        <Link to={`/w/${workspaceId}/${WHATS_NEW_PATH}`} className={buttonClassName({ variant: 'primary', size: 'sm' })}>{t('whatsNew.open')}</Link>
      </div>
    </section>
  );
}
