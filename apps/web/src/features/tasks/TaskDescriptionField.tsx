import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type DragEvent, type ReactNode, type RefObject } from 'react';
import { descriptionAttachmentLine, descriptionBody, descriptionPlainText, descriptionWithFiles, isDescriptionWithFiles } from '@workloom/contracts';
import { inputClassName } from '@workloom/ui';
import { FileUp } from 'lucide-react';
import { useOutletContext } from 'react-router';
import { useTranslation } from '../../i18n';
import { useTaskAttachments } from '../attachments/TaskAttachments';
import { MentionTextarea } from '../task-comments/MentionTextarea';
import { LinkedDescription } from './LinkedDescription';
import type { RichDescriptionHandle } from './RichDescriptionEditor';
import { hasDescriptionLinks } from './descriptionLinks';
import { descriptionOffsetAt, placeDescriptionFile, rebaseDescriptionOffset } from './descriptionPlacement';
import { TASK_DESCRIPTION_MAX } from './taskDraft';

const RichDescriptionEditor = lazy(() => import('./RichDescriptionEditor').then(module => ({ default: module.RichDescriptionEditor })));

interface Props {
  id: string;
  errorId: string;
  value: string;
  error: ReactNode;
  disabled: boolean;
  saved: boolean;
  onChange(value: string): void;
  onCommit(): void;
  commitOnCtrlEnter: boolean;
}

/** Grows a textarea with its text where CSS `field-sizing: content` is missing (Firefox, older Safari). */
export function useTextareaHeight(input: RefObject<HTMLTextAreaElement | null>, value: string, visible: boolean) {
  useLayoutEffect(() => {
    const element = input.current;
    if (!element || window.CSS?.supports?.('field-sizing', 'content')) return;
    const measure = () => {
      element.style.height = 'auto';
      element.style.height = `${element.scrollHeight + element.offsetHeight - element.clientHeight}px`;
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth !== width) { width = element.clientWidth; measure(); }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [input, value, visible]);
}

export function TaskDescriptionField(props: Props) {
  const { id, value, error, errorId, disabled, saved, onChange, onCommit, commitOnCtrlEnter } = props;
  const { t } = useTranslation();
  const surface = useTaskAttachments();
  const scope = useOutletContext<{ actorId: string; workspace: { id: string } } | null>();
  const [editing, setEditing] = useState(false);
  const [fileDoesNotFit, setFileDoesNotFit] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const linked = useRef<HTMLDivElement>(null);
  const richEditor = useRef<RichDescriptionHandle>(null);
  const focusAfterDrop = useRef<number | null>(null);
  const legacy = saved && !isDescriptionWithFiles(value) ? surface?.rows.filter(row => row.inDescription) ?? [] : [];
  const effectiveValue = legacy.length
    ? descriptionWithFiles([...(value ? [value] : []), ...legacy.map(row => descriptionAttachmentLine(row.id)), ''].join('\n'))
    : value;
  const rich = saved && isDescriptionWithFiles(effectiveValue);
  const reading = !rich && !editing && hasDescriptionLinks(value);
  const current = useRef({ effectiveValue, disabled, onChange, onCommit });
  const mounted = useRef(false);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => { current.current = { effectiveValue, disabled, onChange, onCommit }; }, [effectiveValue, disabled, onChange, onCommit]);
  useEffect(() => { if (editing) input.current?.focus(); }, [editing]);
  const captureEditor = useCallback((editor: RichDescriptionHandle | null) => {
    richEditor.current = editor;
    if (editor && focusAfterDrop.current !== null) {
      editor.focusAt(focusAfterDrop.current);
      focusAfterDrop.current = null;
    }
  }, []);
  useTextareaHeight(input, value, !reading && !rich);

  const stage = (next: string) => {
    current.current.effectiveValue = next;
    current.current.onChange(next);
    setFileDoesNotFit(false);
  };

  const drop = (event: DragEvent<HTMLDivElement>) => {
    if (!saved || disabled || !surface || !event.dataTransfer.files.length) return;
    event.preventDefault();
    event.stopPropagation();
    const { clientX, clientY } = event;
    let body = descriptionBody(effectiveValue);
    const textControl = input.current ?? linked.current;
    let offset = richEditor.current?.offsetAt(clientX, clientY)
      ?? (textControl ? descriptionOffsetAt(textControl, body, clientX, clientY) : body.length);
    surface.insert(event.dataTransfer.files, attachmentId => {
      if (!mounted.current || current.current.disabled) return;
      const latest = descriptionBody(current.current.effectiveValue);
      const placed = placeDescriptionFile(latest, rebaseDescriptionOffset(body, latest, offset), attachmentId);
      const next = descriptionWithFiles(placed.body);
      if (next.length > TASK_DESCRIPTION_MAX) { setFileDoesNotFit(true); return; }
      body = placed.body;
      offset = placed.next;
      if (richEditor.current) richEditor.current.updateBody(body);
      else {
        if (input.current === document.activeElement) focusAfterDrop.current = offset;
        stage(next);
      }
      current.current.onCommit();
    });
  };

  const labelId = `${id}-label`;
  const dropActive = saved && !disabled && surface?.dropTarget === 'description';
  const plainInput: ComponentProps<'textarea'> = {
    ref: input, id, className: inputClassName('description-frame description-plain-input mt-1.5 h-auto py-2 leading-relaxed'),
    rows: 3, placeholder: t('tasks.taskFields.descriptionPlaceholder'), value, maxLength: TASK_DESCRIPTION_MAX, disabled,
    'aria-invalid': error ? true : undefined, 'aria-describedby': error ? errorId : undefined,
    onBlur: () => { onCommit(); setEditing(false); },
    onKeyDown: event => {
      if (!commitOnCtrlEnter || event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || event.nativeEvent.isComposing) return;
      event.preventDefault();
      onCommit();
    },
  };
  return <div data-attachment-description={saved && !disabled ? '' : undefined} onDrop={drop} className="relative min-w-0">
    <label id={labelId} htmlFor={id} className="text-sm font-medium text-ink">{t('tasks.taskFields.description')}</label>
    {rich ? <Suspense fallback={<div aria-busy="true" className="description-frame mt-1.5 whitespace-pre-wrap break-words rounded-lg border border-line bg-surface px-3 py-2 text-sm leading-relaxed">{descriptionPlainText(effectiveValue)}</div>}>
        <RichDescriptionEditor editorRef={captureEditor} id={id} labelId={labelId} errorId={error ? errorId : undefined}
          value={effectiveValue} disabled={disabled} onChange={stage} onCommit={onCommit} commitOnCtrlEnter={commitOnCtrlEnter} />
      </Suspense>
      : reading ? <div ref={linked} id={id} role="textbox" tabIndex={0} aria-readonly="true" aria-labelledby={labelId} data-description-links=""
          className={inputClassName('description-frame mt-1.5 h-auto cursor-text whitespace-pre-wrap break-words py-2 leading-relaxed')}
          onClick={event => { if (!disabled && !(event.target instanceof Element && event.target.closest('a'))) setEditing(true); }}
          onKeyDown={event => { if (!disabled && event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); setEditing(true); } }}>
          <LinkedDescription text={value} />
        </div>
        : scope ? <MentionTextarea {...plainInput} value={value} actorId={scope.actorId} workspaceId={scope.workspace.id}
          mentionPeople={false} onValueChange={stage} />
          : <textarea {...plainInput} onChange={event => stage(event.target.value)} />}
    {dropActive ? <div role="status" className="pointer-events-none absolute inset-0 rounded-lg ring-2 ring-accent">
      <span className="absolute top-0 right-0 flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-1 text-xs text-accent shadow-sm">
        <FileUp size={14} aria-hidden="true" />{t('attachments.dropDescription')}
      </span>
    </div> : null}
    {fileDoesNotFit ? <p role="status" className="mt-1.5 text-sm text-muted">{t('attachments.descriptionFull')}</p> : null}
    {error}
  </div>;
}
