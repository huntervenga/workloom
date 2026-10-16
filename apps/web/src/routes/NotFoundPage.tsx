import { t, useTranslation } from '../i18n';
import { StateCard, buttonClassName } from '@workloom/ui';
import { ArrowLeft, SearchX } from 'lucide-react';
import { Link } from 'react-router';
import { useDocumentTitle } from '../lib/useDocumentTitle';

export function NotFoundPage() {
  useTranslation();
  useDocumentTitle(t('routes.notFound'));
  return (
    <StateCard
      headingLevel={1}
      icon={<SearchX size={18} aria-hidden="true" />}
      title={t('routes.notFound')}
      description={t('routes.notFoundDescription')}
      actions={
        <Link to="/" className={buttonClassName({ variant: 'primary' })}>
          <ArrowLeft size={16} aria-hidden="true" />

          {t('routes.backOverview')}
        </Link>
      }
    />
  );
}
