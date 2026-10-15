import { StateCard, buttonClassName } from '@workloom/ui';
import { ArrowLeft, SearchX } from 'lucide-react';
import { Link } from 'react-router';
import { useDocumentTitle } from '../lib/useDocumentTitle';

export function NotFoundPage() {
  useDocumentTitle('Страница не найдена');
  return (
    <StateCard
      headingLevel={1}
      icon={<SearchX size={18} aria-hidden="true" />}
      title="Страница не найдена"
      description="Такой страницы нет. Проверьте адрес или вернитесь к рабочему пространству."
      actions={
        <Link to="/" className={buttonClassName({ variant: 'primary' })}>
          <ArrowLeft size={16} aria-hidden="true" />
          Вернуться к обзору
        </Link>
      }
    />
  );
}
