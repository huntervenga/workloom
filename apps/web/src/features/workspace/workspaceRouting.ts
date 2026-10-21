import type { WorkspaceDto } from '@workloom/contracts';
import type { To } from 'react-router';

export type WorkspaceAddress = Pick<WorkspaceDto, 'id' | 'slug' | 'slugAliases'>;

/** Browser addresses are aliases only; identity, API paths and cache keys remain UUIDs. */
export function workspaceReference(workspace: WorkspaceAddress): string {
  return workspace.slug || workspace.id;
}

export function resolveWorkspaceReference(reference: string, workspaces: readonly WorkspaceAddress[]): WorkspaceAddress | undefined {
  const ref = reference.toLowerCase();
  return workspaces.find(workspace => workspace.id.toLowerCase() === ref || workspace.slug === ref || workspace.slugAliases?.includes(ref));
}

export function workspaceHref(workspace: WorkspaceAddress | string, suffix = ''): string {
  return `/w/${encodeURIComponent(typeof workspace === 'string' ? workspace : workspaceReference(workspace))}${suffix}`;
}

/** Only same-app workspace path segments change; all task/query/hash state stays byte-for-byte. */
export function canonicalWorkspacePath(path: string, workspaces: readonly WorkspaceAddress[]): string {
  return path.replace(/^(\/(?:app\/)?w\/)([^/?#]+)/, (original, prefix: string, raw: string) => {
    let ref: string;
    try { ref = decodeURIComponent(raw); } catch { return original; }
    const workspace = resolveWorkspaceReference(ref, workspaces);
    return workspace ? `${prefix}${encodeURIComponent(workspaceReference(workspace))}` : original;
  });
}

export function canonicalWorkspaceTo(to: To, workspaces: readonly WorkspaceAddress[]): To {
  if (typeof to === 'string') return canonicalWorkspacePath(to, workspaces);
  return to.pathname === undefined ? to : { ...to, pathname: canonicalWorkspacePath(to.pathname, workspaces) };
}
