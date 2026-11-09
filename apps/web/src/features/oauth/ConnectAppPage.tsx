import { t, useTranslation } from '../../i18n';
import { Button, StateCard } from '@workloom/ui';
import { KeyRound, LoaderCircle, PlugZap, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { useLocation } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useDocumentTitle } from '../../lib/useDocumentTitle';
import { decideConsent, fetchConsent } from './api';

/** Leaves the app for the connecting client's callback; a seam so tests can observe it. */
export const consentNavigation = { assign: (url: string) => { window.location.assign(url); } };

/**
 * Consent for a connected app (OAuth). The shell has already signed the person in; approving sends the
 * browser back to the app's registered callback with a single-use code.
 */
export function ConnectAppPage() {
  useTranslation();
  useDocumentTitle(t('oauth.title'));
  const request = useLocation().search.replace(/^\?/, '');
  const consent = useQuery({ queryKey: ['oauth-consent', request], queryFn: ({ signal }) => fetchConsent(request, signal), retry: false, staleTime: Infinity });
  const [sending, setSending] = useState<'approve' | 'deny' | null>(null);
  const [failed, setFailed] = useState(false);

  const decide = async (decision: 'approve' | 'deny') => {
    setSending(decision); setFailed(false);
    try {
      const result = await decideConsent({ request, decision });
      consentNavigation.assign(result.redirectTo);
    } catch {
      setFailed(true); setSending(null);
    }
  };

  if (request === '' || consent.isError) {
    return <StateCard headingLevel={1} tone="error" icon={<TriangleAlert size={18} aria-hidden="true" />} title={t('oauth.invalidTitle')} description={t('oauth.invalidDescription')} />;
  }
  if (!consent.data) {
    return (
      <p role="status" className="flex items-center gap-2.5 p-6 text-sm text-muted">
        <LoaderCircle size={18} aria-hidden="true" className="text-accent motion-safe:animate-spin" />

        {t('oauth.loading')}
      </p>
    );
  }
  const { client, scopes, user } = consent.data;
  return (
    <section aria-labelledby="oauth-consent-title" className="mx-auto my-10 w-full max-w-lg rounded-xl border border-line bg-surface p-6 shadow-sm">
      <span className="mb-4 inline-flex size-10 items-center justify-center rounded-full bg-accent-soft text-accent"><PlugZap size={20} aria-hidden="true" /></span>
      <h1 id="oauth-consent-title" className="text-lg font-semibold text-ink">{t('oauth.heading', { name: client.name })}</h1>
      <p className="mt-2 text-sm text-muted">{t('oauth.signedInAs', { name: user.displayName })}</p>
      <p className="mt-4 text-sm text-ink">{t('oauth.willAllow')}</p>
      <ul className="mt-2 space-y-1.5 text-sm text-ink">
        {scopes.map(scope => (
          <li key={scope} className="flex items-start gap-2">
            <KeyRound size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-muted" />

            {scope === 'read' ? t('oauth.scopeRead') : t('oauth.scopeWrite')}
          </li>
        ))}
      </ul>
      <p className="mt-4 rounded-md border border-line bg-canvas p-3 text-xs text-muted">{t('oauth.redirectNotice', { host: client.redirectHost })}</p>
      <p className="mt-3 text-xs text-muted">{t('oauth.revokeHint')}</p>
      {failed && <p role="alert" className="mt-3 text-sm text-danger">{t('oauth.failed')}</p>}
      <div className="mt-6 flex flex-wrap justify-end gap-2">
        <Button onClick={() => void decide('deny')} disabled={sending !== null}>{t('oauth.deny')}</Button>
        <Button variant="primary" onClick={() => void decide('approve')} disabled={sending !== null}>
          {sending === 'approve' ? t('oauth.connecting') : t('oauth.approve')}
        </Button>
      </div>
    </section>
  );
}
