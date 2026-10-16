import { t, useTranslation, type TranslationKey } from '../i18n';
import { Component, lazy, Suspense, useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { Button } from '@workloom/ui';
import { PageSkeleton } from '../shared/PageSkeleton';
import { probeAppUpdate, reloadCurrentTab, type AppUpdate } from './routeRecovery';

class RouteImportError extends Error {}
type RouteFailureKind = 'import' | 'render' | null;

function RouteFailure({ kind, onRetry }: { kind: Exclude<RouteFailureKind, null>; onRetry: () => void }) {
  useTranslation();
  const [update, setUpdate] = useState<AppUpdate>('unknown');
  useEffect(() => {
    if (kind !== 'import') return undefined;
    const controller = new AbortController();
    void probeAppUpdate(document, window.location.href, controller.signal).then(result => {
      if (!controller.signal.aborted) setUpdate(result);
    });
    return () => controller.abort();
  }, [kind]);
  const updated = update === 'updated';
  return (
    <section role="alert" className="space-y-3 rounded-xl border border-line bg-surface p-5">
      <h1 className="text-lg font-semibold">{updated ? t('shell.appUpdated') : t('shell.routeFailed')}</h1>
      <p className="text-sm text-muted">{updated ? t('shell.appUpdatedHelp') : kind === 'import' ? t('shell.routeFilesFailedHelp') : t('shell.routeFailedHelp')}</p>
      <div className="flex flex-wrap gap-2">
        <Button onClick={onRetry}>{t('shell.retryPage')}</Button>
        <Button variant={updated ? 'primary' : 'ghost'} onClick={reloadCurrentTab}>{t('shell.reloadTab')}</Button>
      </div>
    </section>
  );
}

class RouteBoundary extends Component<{ children: ReactNode; onRetry: () => void }, { failure: RouteFailureKind }> {
  override state: { failure: RouteFailureKind } = { failure: null };
  static getDerivedStateFromError(error: unknown) { return { failure: error instanceof RouteImportError ? 'import' as const : 'render' as const }; }
  override render() {
    return this.state.failure ? <RouteFailure kind={this.state.failure} onRetry={this.props.onRetry} /> : this.props.children;
  }
}

/** Call once at module scope. Query-string changes keep this wrapper and its page mounted. */
export function createAsyncRoute(load: () => Promise<{ default: ComponentType }>, label: TranslationKey) {
  const importPage = async () => {
    try { return await load(); } catch { throw new RouteImportError(); }
  };
  return function AsyncRoute() {
    useTranslation();
    const [Loaded, setLoaded] = useState(() => lazy(importPage));
    const [attempt, setAttempt] = useState(0);
    const retry = () => { setLoaded(() => lazy(importPage)); setAttempt(before => before + 1); };
    return <RouteBoundary key={attempt} onRetry={retry}><Suspense fallback={<PageSkeleton label={t(label)} />}><Loaded /></Suspense></RouteBoundary>;
  };
}
