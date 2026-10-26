import type { TagDto } from '@workloom/contracts';
import { useTranslation } from '../../i18n';
import { TagBadge } from '../tasks/TagBadge';
import { useCanonicalWorkspaceTo } from '../workspace/WorkspaceNavigation';

/** A new tab keeps the enclosing task's unsaved selection and editor in place. */
export function TagLink({ tag }: { tag: TagDto }) {
  const { t } = useTranslation();
  const canonical = useCanonicalWorkspaceTo();
  const href = `/app${canonical(`/w/${tag.workspaceId}/tags/${tag.id}`) as string}`;
  return <a href={href} target="_blank" rel="noopener noreferrer" title={t('tags.openNewTab', { name: tag.name })}
    className="min-w-0 rounded hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
    <TagBadge tag={tag} />
  </a>;
}
