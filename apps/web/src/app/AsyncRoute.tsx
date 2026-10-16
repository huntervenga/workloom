import { t, useTranslation, type TranslationKey } from '../i18n';
import { Component, lazy, Suspense, useState, type ComponentType, type ReactNode } from 'react';
import { Button } from '@workloom/ui';
import { PageSkeleton } from '../shared/PageSkeleton';

class RouteBoundary extends Component<{ children: ReactNode; onRetry: () => void }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override render() {
    return this.state.failed ? <section role="alert" className="space-y-3 rounded-xl border border-line bg-surface p-5"><h1 className="text-lg font-semibold">{t('shell.routeFailed')}</h1><p className="text-sm text-muted">{t('shell.routeFailedHelp')}</p><div className="flex flex-wrap gap-2"><Button onClick={this.props.onRetry}>{t('shell.retryPage')}</Button><Button variant="ghost" onClick={() => window.location.reload()}>{t('shell.reloadTab')}</Button></div></section> : this.props.children;
  }
}

/** Call once at module scope. Query-string changes keep this wrapper and its page mounted. */
export function createAsyncRoute(load: () => Promise<{ default: ComponentType }>, label: TranslationKey) {
  return function AsyncRoute() {
    useTranslation();
    const [Loaded, setLoaded] = useState(() => lazy(load));
    const [attempt, setAttempt] = useState(0);
    const retry = () => { setLoaded(() => lazy(load)); setAttempt(before => before + 1); };
    return <RouteBoundary key={attempt} onRetry={retry}><Suspense fallback={<PageSkeleton label={t(label)} />}><Loaded /></Suspense></RouteBoundary>;
  };
}
