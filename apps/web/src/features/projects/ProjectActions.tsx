import { MoreHorizontal } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from '../../i18n';
import { DialogReturnFocus } from '../../shared/DialogShell';

/** Disclosure children stay mounted so closing the action list cannot discard modal drafts. */
export function ProjectActions({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const summaryRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !detailsRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  return <details ref={detailsRef} open={open} className="relative shrink-0" onKeyDown={event => {
    if (event.key === 'Escape' && !event.defaultPrevented && event.target instanceof Node && event.currentTarget.contains(event.target)) {
      event.preventDefault(); setOpen(false); summaryRef.current?.focus();
    }
  }}>
    <summary ref={summaryRef} onClick={event => { event.preventDefault(); setOpen(before => !before); }} aria-label={t('projects.projectPage.projectActions')} title={t('projects.projectPage.projectActions')} className="flex size-8 cursor-pointer list-none items-center justify-center rounded-lg border border-line bg-surface text-muted hover:bg-canvas [&::-webkit-details-marker]:hidden"><MoreHorizontal size={18} aria-hidden="true" /></summary>
    <DialogReturnFocus targetRef={summaryRef}>
      <div aria-label={t('projects.projectPage.projectActions')} onClick={event => {
        if (event.target instanceof Element && event.currentTarget.contains(event.target) && event.target.closest('button, a')) setOpen(false);
      }} className="absolute right-0 z-30 mt-2 flex w-64 max-w-[calc(100vw-2rem)] flex-col gap-1 rounded-xl border border-line bg-surface p-2 shadow-lg [&_button]:w-full [&_button]:justify-start">
        <p className="px-2 py-1 text-xs font-medium text-muted">{t('projects.projectPage.projectActions')}</p>
        {children}
      </div>
    </DialogReturnFocus>
  </details>;
}
