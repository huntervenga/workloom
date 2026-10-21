import { workspaceHref } from './workspaceRouting';
import { useWorkspaceNavigate as useNavigate } from './WorkspaceNavigation';
import { t, useTranslation } from '../../i18n';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Avatar, Button, Skeleton } from '@workloom/ui';
import { Check, ChevronsUpDown, Plus, RefreshCw } from 'lucide-react';
import { useId, useRef } from 'react';

import { roleLabels } from './roles';
import { useWorkspacesQuery } from './queries';
import { useWorkspaceCreation } from './WorkspaceCreation';

const sectionLabel = 'px-2.5 pb-1.5 text-[11px] font-semibold tracking-[0.08em] text-subtle uppercase';

export interface WorkspaceChooserProps {
  actorId: string;
  workspaceId: string | null;
  onNavigate?: (() => void) | undefined;
}

export function WorkspaceChooser({ actorId, workspaceId, onNavigate }: WorkspaceChooserProps) {
  useTranslation();
  const workspaces = useWorkspacesQuery(actorId);
  const navigate = useNavigate();
  const creation = useWorkspaceCreation();
  const labelId = useId();
  const valueId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  // The menu closes as the dialog opens; its focus return must not pull focus out of the dialog.
  const openingCreation = useRef(false);

  if (workspaces.isPending) {
    return (
      <div role="status">
        <span className="sr-only">{t('workspace.loading')}</span>
        <Skeleton className="h-[3.25rem] w-full rounded-xl" />
      </div>
    );
  }

  if (workspaces.isError) {
    return (
      <div role="alert" className="rounded-xl border border-red-200 bg-red-50/60 p-3">
        <p className="text-xs font-medium text-red-800">{t('workspace.listFailed')}</p>
        <Button
          size="sm"
          variant="ghost"
          className="-ml-1 mt-1"
          aria-disabled={workspaces.isFetching || undefined}
          onClick={() => {
            if (!workspaces.isFetching) void workspaces.refetch();
          }}
        >
          <RefreshCw size={16} aria-hidden="true" className={workspaces.isFetching ? 'motion-safe:animate-spin' : undefined} />

          {t('common.retry')}
        </Button>
      </div>
    );
  }

  if (workspaces.data.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-line-strong px-3 py-2.5">
        <p className="text-xs text-muted">{t('workspace.noneAvailable')}</p>
        {creation.canCreate ? (
          <Button
            size="sm"
            variant="ghost"
            className="-ml-1 mt-1"
            onClick={(event) => {
              creation.show(event.currentTarget);
              onNavigate?.();
            }}
          >
            <Plus size={16} aria-hidden="true" />
            {t('workspace.create.open')}
          </Button>
        ) : null}
      </div>
    );
  }

  const current = workspaces.data.find((workspace) => workspace.id === workspaceId) ?? null;

  return (
    <div>
      <p id={labelId} className={sectionLabel}>

        {t('workspace.label')}
      </p>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            ref={triggerRef}
            type="button"
            aria-labelledby={`${labelId} ${valueId}`}
            className="flex w-full items-center gap-2.5 rounded-xl border border-line bg-surface p-2 text-left shadow-xs transition-colors hover:border-line-strong data-[state=open]:border-accent-line data-[state=open]:ring-4 data-[state=open]:ring-accent-soft"
          >
            {current ? (
              <Avatar name={current.name} seed={current.id} shape="square" />
            ) : (
              <span aria-hidden="true" className="size-8 shrink-0 rounded-lg border border-dashed border-line-strong" />
            )}
            <span id={valueId} className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-ink">
                {current ? current.name : t('workspace.choose')}
              </span>
              {current ? <span className="block truncate text-xs text-muted">{roleLabels[current.role]}</span> : null}
            </span>
            <ChevronsUpDown size={16} aria-hidden="true" className="shrink-0 text-subtle" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="start"
            sideOffset={6}
            collisionPadding={12}
            onCloseAutoFocus={(event) => {
              if (!openingCreation.current) return;
              openingCreation.current = false;
              event.preventDefault();
            }}
            className="z-50 max-h-[var(--radix-dropdown-menu-content-available-height)] w-[var(--radix-dropdown-menu-trigger-width)] min-w-56 max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-xl border border-line bg-surface p-1.5 shadow-lg shadow-slate-900/5"
          >
            <DropdownMenu.Label className="px-2 pt-1 pb-1.5 text-[11px] font-semibold tracking-[0.08em] text-subtle uppercase">

              {t('workspace.available')}
            </DropdownMenu.Label>
            <DropdownMenu.RadioGroup
              value={current?.id ?? ''}
              onValueChange={(id) => {
                const selected = workspaces.data.find(workspace => workspace.id === id);
                if (selected) void navigate(workspaceHref(selected));
                onNavigate?.();
              }}
            >
              {workspaces.data.map((workspace) => (
                <DropdownMenu.RadioItem
                  key={workspace.id}
                  value={workspace.id}
                  className="flex cursor-default items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm outline-none select-none data-[highlighted]:bg-slate-100"
                >
                  <Avatar name={workspace.name} seed={workspace.id} shape="square" size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-ink" title={workspace.name}>
                      {workspace.name}
                    </span>
                    <span className="block text-xs text-muted">{roleLabels[workspace.role]}</span>
                  </span>
                  <DropdownMenu.ItemIndicator>
                    <Check size={16} aria-hidden="true" className="text-accent" />
                  </DropdownMenu.ItemIndicator>
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
            {creation.canCreate ? (
              <>
                <DropdownMenu.Separator className="my-1.5 h-px bg-line" />
                <DropdownMenu.Item
                  className="flex cursor-default items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm font-medium text-ink outline-none select-none data-[highlighted]:bg-slate-100"
                  onSelect={() => {
                    openingCreation.current = true;
                    creation.show(triggerRef.current);
                    onNavigate?.();
                  }}
                >
                  <Plus size={16} aria-hidden="true" className="text-subtle" />
                  {t('workspace.create.open')}
                </DropdownMenu.Item>
              </>
            ) : null}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}
