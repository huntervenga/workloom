import { useEffect } from 'react';
import { useTranslation } from '../i18n';

export function useDocumentTitle(title: string | null): void {
  const { t, locale } = useTranslation();
  useEffect(() => {
    document.title = title ? t('common.documentTitle', { title }) : t('common.brand');
  }, [title, t, locale]);
}
