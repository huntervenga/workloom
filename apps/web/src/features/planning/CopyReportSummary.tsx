import { useTranslation } from '../../i18n';
import { Button } from '@workloom/ui';
import { Copy } from 'lucide-react';
import { useId, useState } from 'react';

type CopyResult = { state: 'idle' } | { state: 'copied' } | { state: 'failed'; text: string };

/**
 * Copies a plain-text brief only after an explicit click. Nothing is sent, stored or queried; the brief is
 * built at click time and rendered only as the manual-copy fallback. Mount it under a per-run key so a
 * different saved run starts from idle. Success and failure are announced in the same polite status;
 * focus stays on the button and the fallback text is never selected automatically.
 */
export function CopyReportSummary({ brief }: { brief: () => string }) {
  const { t } = useTranslation();
  const id = useId();
  const [result, setResult] = useState<CopyResult>({ state: 'idle' });
  const copy = async () => {
    const text = brief();
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (typeof clipboard?.writeText !== 'function') { setResult({ state: 'failed', text }); return; }
    try {
      await clipboard.writeText(text);
      setResult({ state: 'copied' });
    } catch {
      setResult({ state: 'failed', text });
    }
  };
  return (
    <div className="space-y-2">
      <Button size="sm" onClick={() => void copy()}><Copy size={14} aria-hidden="true" />{t('reportUX.copy.button')}</Button>
      <p role="status" aria-live="polite" className={result.state === 'failed' ? 'text-xs font-medium text-ink-soft' : 'text-xs text-muted'}>{result.state === 'copied' ? t('reportUX.copy.copied') : result.state === 'failed' ? t('reportUX.copy.failed') : null}</p>
      {result.state === 'failed' ? (
        <div>
          <label htmlFor={`${id}-manual`} className="sr-only">{t('reportUX.copy.manualLabel')}</label>
          <textarea id={`${id}-manual`} readOnly value={result.text} rows={8} className="block w-full max-w-full resize-y rounded-lg border border-line bg-surface p-2 font-mono text-xs text-ink" />
        </div>
      ) : null}
    </div>
  );
}
