import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Button } from '@workloom/ui';
import { ChevronDown, Phone, Plus } from 'lucide-react';
import { useRef } from 'react';
import { useTranslation } from '../../i18n';
import type { SectionCreateReturnFocus } from './SectionCreateForm';

/** The primary action stays a normal button; the adjacent menu owns its keyboard navigation. */
export function ProjectCreateMenu({ onAddTask, onAddSection, onAddSharedActivity, returnFocus }: { onAddSharedActivity?: () => void; onAddTask: () => void; onAddSection: () => void; returnFocus: SectionCreateReturnFocus }) {
  const { t } = useTranslation();
  const sectionChosen = useRef(false);
  return <div className="flex shrink-0 items-center gap-px">
    <Button size="sm" variant="primary" className="rounded-r-none" onClick={onAddTask}><Plus size={16} aria-hidden="true" />{t('projects.projectPage.newTask')}</Button>
    <DropdownMenu.Root modal={false} onOpenChange={open => { if (open) sectionChosen.current = false; }}>
      <DropdownMenu.Trigger asChild><Button ref={returnFocus} size="sm" variant="primary" className="rounded-l-none px-2" aria-label={t('projects.sectionCreate.moreOptions')} title={onAddSharedActivity?t('sharedActivities.addOptionsHelp'):undefined}><ChevronDown size={16} aria-hidden="true" /></Button></DropdownMenu.Trigger>
      <DropdownMenu.Portal><DropdownMenu.Content align="end" sideOffset={4} aria-label={t('projects.sectionCreate.menu')} aria-labelledby={undefined} onCloseAutoFocus={event => { if (sectionChosen.current) event.preventDefault(); }} className="z-50 min-w-44 rounded-lg border border-line bg-surface p-1 text-sm text-ink shadow-lg">
        {onAddSharedActivity?<DropdownMenu.Item className="cursor-pointer rounded px-3 py-2 outline-none focus:bg-canvas" onSelect={()=>{sectionChosen.current=true;onAddSharedActivity();}}><span className="flex items-center gap-2"><Phone size={14} aria-hidden="true" />{t('sharedActivities.menuLabel')}</span></DropdownMenu.Item>:null}
        <DropdownMenu.Item className="cursor-pointer rounded px-3 py-2 outline-none focus:bg-canvas" onSelect={() => { sectionChosen.current = true; onAddSection(); }}>{t('projects.sectionCreate.addSection')}</DropdownMenu.Item>
      </DropdownMenu.Content></DropdownMenu.Portal>
    </DropdownMenu.Root>
  </div>;
}
