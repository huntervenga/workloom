import { rememberProjectReturn } from '../projects/projectReturn';
import { useLocation, useOutletContext } from 'react-router';
import { ArrowUpRight } from 'lucide-react';
import { useTranslation } from '../../i18n';
import { useProjectQuery } from '../projects/queries';
import { WorkspaceLink } from '../workspace/WorkspaceNavigation';
import { resolveWorkspaceReference, type WorkspaceAddress } from '../workspace/workspaceRouting';
import { useTaskQuery } from './queries';
import { parseProjectReference, splitDescription } from './descriptionLinks';

const MAX_RESOLVED_LINKS = 12;

interface Scope { actorId: string; workspace: WorkspaceAddress }

function WebLink({ href }: { href: string }) {
  return <a className="break-all text-accent-ink underline underline-offset-2 hover:text-accent-strong" href={href} target="_blank" rel="noopener noreferrer">{href}</a>;
}

function ReferenceLink({ href, scope, projectId, taskId, preview }: { href: string; scope: Scope; projectId: string; taskId: string | null; preview: boolean }) {
  const location = useLocation();
  const task = useTaskQuery(scope.actorId, scope.workspace.id, taskId ?? '');
  const project = useProjectQuery(scope.actorId, scope.workspace.id, taskId === null ? projectId : '');
  const entity = taskId === null ? project.isSuccess ? project.data : null : task.isSuccess ? task.data : null;
  if (!entity || entity.workspaceId !== scope.workspace.id) return preview ? null : <WebLink href={href} />;
  const home = taskId !== null && 'projectId' in entity ? entity.projectId : projectId;
  const to = `/w/${scope.workspace.id}/projects/${home}${taskId === null ? '' : `?task=${taskId}`}`;
  return <WorkspaceLink className="break-words rounded bg-accent-soft px-1 text-accent-ink hover:underline" to={to}
    onClick={event => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      rememberProjectReturn(scope.actorId, scope.workspace.id, location.key);
    }}>
    <ArrowUpRight size={12} aria-hidden="true" className="mr-0.5 inline align-baseline" />
    {'title' in entity ? entity.title : entity.name}
  </WorkspaceLink>;
}

/** Saved text keeps its original URL. Only currently readable internal targets get a named link. */
export function LinkedDescription({ text, preview = false, internalOnly = false }: { text: string; preview?: boolean; internalOnly?: boolean }) {
  const scope = useOutletContext<Scope | null>();
  const { t } = useTranslation();
  const seen = new Set<string>();
  const parts = splitDescription(text);
  if (internalOnly && !parts.some(part => part.kind === 'link' && scope &&
    parseProjectReference(part.href, window.location.origin))) return <>{text}</>;
  let resolved = 0;
  const content = parts.map((part, index) => {
    if (part.kind === 'text') return preview ? null : <span key={index} data-description-length={part.text.length}>{part.text}</span>;
    const reference = scope ? parseProjectReference(part.href, window.location.origin) : null;
    const local = scope && reference && resolveWorkspaceReference(reference.workspaceReference, [scope.workspace]);
    if (!scope || !reference || !local || resolved >= MAX_RESOLVED_LINKS) return preview ? null : <span key={index} data-description-length={part.href.length} data-description-link="">{internalOnly ? part.href : <WebLink href={part.href} />}</span>;
    const key = reference.taskId ?? reference.projectId;
    if (preview && seen.has(key)) return null;
    seen.add(key);
    resolved += 1;
    const link = <ReferenceLink key={index} href={part.href} scope={scope} projectId={reference.projectId} taskId={reference.taskId} preview={preview} />;
    return preview ? link : <span key={index} data-description-length={part.href.length} data-description-link="">{link}</span>;
  });
  return preview ? <div aria-label={t('tasks.referencePreview')} className="flex flex-wrap gap-1.5 text-xs empty:hidden">{content}</div> : <>{content}</>;
}
