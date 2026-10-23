import { Link2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@workloom/ui';
import { useTranslation } from '../../i18n';

/** The address that opens this task in its project, for pasting into chat or an e-mail. */
export function taskLink(origin: string, workspaceId: string, projectId: string, taskId: string): string {
  return `${origin}/app/w/${workspaceId}/projects/${projectId}?task=${taskId}`;
}

export function CopyTaskLink({ workspaceId, projectId, taskId }: { workspaceId: string; projectId: string; taskId: string }) {
  const { t } = useTranslation();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(taskLink(window.location.origin, workspaceId, projectId, taskId));
      setState('copied');
    } catch { setState('failed'); }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 2500);
  };
  return <>
    <Button size="sm" variant="ghost" onClick={() => void copy()}><Link2 size={16} aria-hidden="true" />{t('copyTaskLink.button')}</Button>
    <span role="status" className="text-xs text-muted">{state === 'copied' ? t('copyTaskLink.copied') : state === 'failed' ? t('copyTaskLink.failed') : ''}</span>
  </>;
}
