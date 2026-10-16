import { t, useTranslation } from '../i18n';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { createContext, useContext, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactElement, type ReactNode } from 'react';

interface DialogLayer {
  parent: DialogLayer | null;
}

const DialogLayerContext = createContext<DialogLayer | null>(null);
let openLayers: readonly DialogLayer[] = [];
const layerListeners = new Set<() => void>();
const subscribeLayers = (listener: () => void) => {
  layerListeners.add(listener);
  return () => layerListeners.delete(listener);
};
const getLayers = () => openLayers;

/** New dialogs cover every earlier modal, including dialogs outside the same React subtree. */
function registerLayer(layer: DialogLayer): () => void {
  const descendantIndex = openLayers.findIndex((candidate) => {
    for (let parent = candidate.parent; parent !== null; parent = parent.parent) {
      if (parent === layer) return true;
    }
    return false;
  });
  // Child layout effects may run before a parent during the initial mount.
  openLayers = descendantIndex < 0
    ? [...openLayers, layer]
    : [...openLayers.slice(0, descendantIndex), layer, ...openLayers.slice(descendantIndex)];
  for (const listener of layerListeners) listener();
  return () => {
    openLayers = openLayers.filter((candidate) => candidate !== layer);
    for (const listener of layerListeners) listener();
  };
}

export interface DialogShellProps {
  title: string;
  description: string;
  /** Opens the dialog; without one, focus returns to whatever was focused when it opened. */
  trigger?: ReactElement | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `drawer` slides in from the right and takes the full width on small screens. */
  variant?: 'center' | 'drawer' | undefined;
  children: ReactNode;
}

const contentClasses = {
  center:
    'fixed top-1/2 left-1/2 max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-line bg-surface p-5 shadow-xl outline-none sm:p-6',
  // The drawer does not scroll itself: its content scrolls inside and keeps the actions anchored below.
  drawer:
    'fixed inset-y-0 right-0 flex h-dvh w-full max-w-full flex-col overflow-hidden border-l border-line bg-surface p-5 shadow-xl outline-none sm:max-w-xl sm:p-6',
} as const;

/** Radix dialog with a title, description and a visible close button; Escape also closes it. */
export function DialogShell({ title, description, trigger, open, onOpenChange, variant = 'center', children }: DialogShellProps) {
  useTranslation();
  const openerRef = useRef<HTMLElement | null>(null);
  const parentLayer = useContext(DialogLayerContext);
  const [layer] = useState<DialogLayer>(() => ({ parent: parentLayer }));
  const layers = useSyncExternalStore(subscribeLayers, getLayers, getLayers);
  useLayoutEffect(() => {
    if (open) return registerLayer(layer);
    return undefined;
  }, [open, layer]);
  const overlayZ = 40 + Math.max(0, layers.indexOf(layer)) * 20;

  return (
    <DialogLayerContext.Provider value={layer}>
      <Dialog.Root open={open} onOpenChange={onOpenChange}>
        {trigger ? <Dialog.Trigger asChild>{trigger}</Dialog.Trigger> : null}
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-slate-900/30" style={{ zIndex: overlayZ }} />
          <Dialog.Content
            className={contentClasses[variant]}
            style={{ zIndex: overlayZ + 10 }}
            onOpenAutoFocus={() => {
              // Focus has not moved yet, so this is the control that opened the dialog.
              openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            }}
            onCloseAutoFocus={(event) => {
              if (trigger) return;
              event.preventDefault();
              if (openerRef.current?.isConnected) openerRef.current.focus();
            }}
          >
            <div className="flex shrink-0 items-start gap-3">
              <div className="min-w-0 flex-1">
                <Dialog.Title className="text-base font-semibold [overflow-wrap:anywhere] text-ink">{title}</Dialog.Title>
                <Dialog.Description className="mt-1 text-sm leading-relaxed text-muted">{description}</Dialog.Description>
              </div>
              <Dialog.Close
                aria-label={t('common.close')}
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-slate-100 hover:text-ink"
              >
                <X size={16} aria-hidden="true" />
              </Dialog.Close>
            </div>
            {children}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </DialogLayerContext.Provider>
  );
}
