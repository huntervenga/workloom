import { t, useTranslation } from '../i18n';
import { Button, StateCard } from '@workloom/ui';
import { RefreshCw, TriangleAlert } from 'lucide-react';
import { describeError, type ErrorSubject } from '../lib/errors';

export interface QueryErrorStateProps {
  error: unknown;
  subject: ErrorSubject;
  onRetry?: (() => void) | undefined;
  retrying?: boolean | undefined;
  headingLevel?: 1 | 2 | 3 | undefined;
  className?: string | undefined;
}

export function QueryErrorState({ error, subject, onRetry, retrying = false, headingLevel, className }: QueryErrorStateProps) {
  useTranslation();
  const described = describeError(error, subject);
  return (
    <StateCard
      role="alert"
      tone="error"
      headingLevel={headingLevel}
      className={className}
      icon={<TriangleAlert size={18} aria-hidden="true" />}
      title={described.title}
      description={described.description}
      actions={
        described.retryable && onRetry ? (
          <Button
            aria-disabled={retrying || undefined}
            onClick={() => {
              if (!retrying) onRetry();
            }}
          >
            <RefreshCw size={16} aria-hidden="true" className={retrying ? 'motion-safe:animate-spin' : undefined} />
            {retrying ? t('common.retrying') : t('common.retry')}
          </Button>
        ) : null
      }
      footnote={
        described.requestId ? (
          <>

            {t('common.requestId')} <code className="font-mono">{described.requestId}</code>
          </>
        ) : null
      }
    />
  );
}
