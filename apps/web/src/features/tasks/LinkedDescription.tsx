import { useOutletContext } from 'react-router';
import { WorkspaceLink } from '../workspace/WorkspaceNavigation';
import { useTaskQuery } from './queries';
import { parseTaskLink, splitDescription } from './descriptionLinks';

const linkClassName = ['text-accent', 'underline', 'underline-offset-2', 'hover:text-accent-strong'].join(' ');

interface Scope { actorId: string; workspace: { id: string } }

function TaskLink({ href, scope, projectId, taskId }: { href: string; scope: Scope; projectId: string; taskId: string }) {
  const task = useTaskQuery(scope.actorId, scope.workspace.id, taskId);
  if (!task.data) return <a className={linkClassName} href={href} target="_blank" rel="noopener noreferrer">{href}</a>;
  return <WorkspaceLink className={linkClassName} to={`/w/${scope.workspace.id}/projects/${task.data.projectId || projectId}?task=${taskId}`}>{task.data.title}</WorkspaceLink>;
}

/** The description as text, with web addresses coloured and clickable; a link to another task shows that task's title. */
export function LinkedDescription({ text }: { text: string }) {
  const scope = useOutletContext<Scope | undefined>();
  return <>{splitDescription(text).map((part, index) => {
    if (part.kind === 'text') return <span key={index}>{part.text}</span>;
    const task = scope ? parseTaskLink(part.href, window.location.origin) : null;
    if (scope && task) return <TaskLink key={index} href={part.href} scope={scope} {...task} />;
    return <a key={index} className={linkClassName} href={part.href} target="_blank" rel="noopener noreferrer">{part.href}</a>;
  })}</>;
}
