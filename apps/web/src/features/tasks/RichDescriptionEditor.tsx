import { useLayoutEffect, useRef, useState, type Ref } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { descriptionAttachmentId, descriptionAttachmentLine, descriptionBody, descriptionWithFiles } from '@workloom/contracts';
import { baseKeymap } from 'prosemirror-commands';
import { history, redo, undo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import { Schema, type Node as DocumentNode } from 'prosemirror-model';
import { EditorState, Plugin, Selection } from 'prosemirror-state';
import { Decoration, DecorationSet, EditorView } from 'prosemirror-view';
import 'prosemirror-view/style/prosemirror.css';
import { useTranslation } from '../../i18n';
import { DescriptionInlineFile, useTaskAttachments } from '../attachments/TaskAttachments';
import { splitDescription } from './descriptionLinks';
import { rebaseDescriptionOffset } from './descriptionPlacement';
import { TASK_DESCRIPTION_MAX } from './taskDraft';

const schema = new Schema({ nodes: {
  doc: { content: 'block+' },
  paragraph: { group: 'block', content: 'text*', parseDOM: [{ tag: 'p' }], toDOM: () => ['p', 0] },
  file: { group: 'block', atom: true, attrs: { id: {} }, toDOM: () => ['div'] },
  text: {},
} });

function documentFrom(body: string): DocumentNode {
  return schema.node('doc', null, body.split('\n').map(line => {
    const id = descriptionAttachmentId(line);
    return id ? schema.node('file', { id }) : schema.node('paragraph', null, line ? schema.text(line) : undefined);
  }));
}

function lineText(node: DocumentNode): string {
  return node.type.name === 'file' ? descriptionAttachmentLine(String(node.attrs.id)) : node.textContent;
}

function bodyFrom(doc: DocumentNode): string {
  const lines: string[] = [];
  doc.forEach(node => lines.push(lineText(node)));
  return lines.join('\n');
}

function offsetForPosition(doc: DocumentNode, pos: number): number {
  const point = doc.resolve(pos);
  let offset = 0;
  for (let index = 0; index < point.index(0); index++) offset += lineText(doc.child(index)).length + 1;
  return point.depth ? offset + point.parentOffset : Math.min(offset, bodyFrom(doc).length);
}

function positionForOffset(doc: DocumentNode, offset: number): number {
  let position = 0;
  for (let index = 0; index < doc.childCount; index++) {
    const node = doc.child(index), length = lineText(node).length;
    if (offset <= length) return node.isTextblock ? position + 1 + offset : position;
    offset -= length + 1;
    position += node.nodeSize;
  }
  return doc.content.size;
}

const links = new Plugin({
  props: {
    decorations(state) {
      const decorations: Decoration[] = [];
      state.doc.forEach((node, position) => {
        if (!node.isTextblock) return;
        let offset = position + 1;
        for (const part of splitDescription(node.textContent)) {
          const length = (part.kind === 'text' ? part.text : part.href).length;
          if (part.kind === 'link') decorations.push(Decoration.inline(offset, offset + length, {
            nodeName: 'a', href: part.href, target: '_blank', rel: ['noopener', 'noreferrer'].join(' '), class: 'description-rich-link',
          }));
          offset += length;
        }
      });
      return DecorationSet.create(state.doc, decorations);
    },
  },
});

interface Props {
  editorRef: Ref<RichDescriptionHandle>;
  id: string;
  labelId: string;
  errorId?: string | undefined;
  value: string;
  disabled: boolean;
  onChange(value: string): void;
  onCommit(): void;
  commitOnCtrlEnter: boolean;
}
export interface RichDescriptionHandle {
  offsetAt(x: number, y: number): number;
  updateBody(body: string): void;
  focusAt(offset: number): void;
}

function replaceBody(view: EditorView, body: string, addToHistory: boolean) {
  const { state } = view;
  const before = bodyFrom(state.doc);
  if (before === body) return;
  const offset = rebaseDescriptionOffset(before, body, offsetForPosition(state.doc, state.selection.head));
  const next = documentFrom(body);
  const transaction = state.tr.replaceWith(0, state.doc.content.size, next.content).setMeta('addToHistory', addToHistory);
  transaction.setSelection(Selection.near(transaction.doc.resolve(positionForOffset(transaction.doc, offset))));
  view.dispatch(transaction);
}

interface FileView { target: HTMLElement; id: string; key: number; remove(): void }
export function RichDescriptionEditor(props: Props) {
  const host = useRef<HTMLDivElement>(null), viewRef = useRef<EditorView | null>(null);
  const current = useRef(props);
  const [fileViews, setFileViews] = useState<FileView[]>([]);
  useLayoutEffect(() => { current.current = props; }, [props]);
  useLayoutEffect(() => {
    if (!host.current) return;
    const files = new Map<HTMLElement, FileView>();
    let key = 0, active = true;
    const sync = () => { if (active) setFileViews([...files.values()]); };
    const view = new EditorView(host.current, {
      state: EditorState.create({
        doc: documentFrom(descriptionBody(current.current.value)),
        plugins: [
          history(),
          keymap({ 'Mod-z': undo, 'Mod-Shift-z': redo, 'Mod-y': redo }),
          keymap(baseKeymap),
          links,
          new Plugin({ filterTransaction: (transaction, state) => !transaction.docChanged
            || descriptionWithFiles(bodyFrom(transaction.doc)).length <= TASK_DESCRIPTION_MAX
            || bodyFrom(transaction.doc).length < bodyFrom(state.doc).length }),
        ],
      }),
      editable: () => !current.current.disabled,
      attributes: () => ({
        id: current.current.id, role: 'textbox', 'aria-multiline': 'true', 'aria-labelledby': current.current.labelId,
        'aria-readonly': String(current.current.disabled),
        ...(current.current.errorId ? { 'aria-invalid': 'true', 'aria-describedby': current.current.errorId } : {}),
        class: 'description-rich-input min-w-0 px-3 py-2 text-sm leading-relaxed text-ink outline-none',
      }),
      dispatchTransaction(transaction) {
        const previous = view.state;
        const state = previous.apply(transaction);
        view.updateState(state);
        if (!state.doc.eq(previous.doc) && !transaction.getMeta('fromProps')) {
          current.current.onChange(descriptionWithFiles(bodyFrom(state.doc)));
        }
      },
      handleDOMEvents: {
        blur: (editor, event) => {
          if (!(event.relatedTarget instanceof Node && editor.dom.contains(event.relatedTarget))) current.current.onCommit();
          return false;
        },
        click: (_editor, event) => {
          if (!current.current.disabled && !event.metaKey && !event.ctrlKey && event.target instanceof Element && event.target.closest('a')) {
            event.preventDefault();
          }
          return false;
        },
      },
      handleKeyDown: (_editor, event) => {
        if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || event.isComposing || !current.current.commitOnCtrlEnter) return false;
        current.current.onCommit();
        return true;
      },
      nodeViews: {
        file(node, editor, getPos) {
          const target = document.createElement('div');
          target.className = 'description-inline-file my-2';
          target.contentEditable = 'false';
          files.set(target, { target, key: key++, id: String(node.attrs.id), remove: () => {
            const from = getPos();
            if (current.current.disabled || from === undefined) return;
            editor.dispatch(editor.state.tr.delete(from, from + node.nodeSize));
            current.current.onCommit();
          } });
          sync();
          return {
            dom: target,
            ignoreMutation: () => true,
            stopEvent: event => event.target instanceof Element && Boolean(event.target.closest('button')),
            destroy() { files.delete(target); sync(); },
          };
        },
      },
    });
    viewRef.current = view;
    return () => { active = false; viewRef.current = null; view.destroy(); };
  }, []);
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const next = descriptionBody(props.value);
    if (bodyFrom(view.state.doc) !== next) {
      const document = documentFrom(next);
      const transaction = view.state.tr.replaceWith(0, view.state.doc.content.size, document.content)
        .setMeta('addToHistory', false).setMeta('fromProps', true);
      view.dispatch(transaction);
    }
  }, [props.value]);
  useLayoutEffect(() => {
    viewRef.current?.setProps({ editable: () => !current.current.disabled });
  }, [props.disabled, props.errorId, props.id, props.labelId]);
  useLayoutEffect(() => {
    const handle: RichDescriptionHandle = {
      offsetAt(x, y) {
        const view = viewRef.current;
        if (!view) return descriptionBody(current.current.value).length;
        const hit = view.posAtCoords({ left: x, top: y });
        return hit ? offsetForPosition(view.state.doc, hit.pos) : bodyFrom(view.state.doc).length;
      },
      updateBody(body) {
        if (viewRef.current) replaceBody(viewRef.current, body, true);
      },
      focusAt(offset) {
        const view = viewRef.current;
        if (!view) return;
        view.dispatch(view.state.tr.setSelection(Selection.near(view.state.doc.resolve(positionForOffset(view.state.doc, offset)))));
        view.focus();
      },
    };
    const ref = props.editorRef;
    if (typeof ref === 'function') { ref(handle); return () => { ref(null); }; }
    if (ref) ref.current = handle;
    return () => { if (ref) ref.current = null; };
  }, [props.editorRef]);
  return <>
    <div ref={host} className="description-frame mt-1.5 rounded-lg border border-line bg-surface focus-within:border-accent" />
    {fileViews.map(file => createPortal(<InlineFile id={file.id} remove={props.disabled ? undefined : file.remove} />, file.target, file.key))}
  </>;
}

function InlineFile({ id, remove }: { id: string; remove?: (() => void) | undefined }) {
  const { t } = useTranslation();
  const file = useTaskAttachments()?.rows.find(row => row.id === id);
  return <div className="flex w-fit max-w-full items-start gap-1">
    {file ? <DescriptionInlineFile id={id} /> : <span className="block rounded-md border border-line px-2 py-1 pr-8 text-xs text-muted">{t('attachments.inlineUnavailable')}</span>}
    {remove ? <button type="button" aria-label={t('attachments.unlinkDescription')} title={t('attachments.unlinkDescription')}
      className="inline-flex size-6 shrink-0 items-center justify-center rounded border border-line bg-surface text-muted hover:text-ink"
      onClick={remove}><X size={14} aria-hidden="true" /></button> : null}
  </div>;
}
