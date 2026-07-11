import {
  Decoration,
  EditorView,
  keymap,
  placeholder,
  type DecorationSet,
} from '@codemirror/view';
import { EditorState, RangeSetBuilder, StateEffect, StateField, Compartment } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { tags as t } from '@lezer/highlight';

export interface EditorAnnotation {
  id: string;
  from: number;
  to: number;
  kind: 'comment' | 'suggestion';
  active: boolean;
}

export const setAnnotations = StateEffect.define<EditorAnnotation[]>();

function buildDecorations(annotations: EditorAnnotation[], docLength: number): DecorationSet {
  const valid = annotations
    .map((a) => ({ ...a, from: Math.max(0, a.from), to: Math.min(a.to, docLength) }))
    .filter((a) => a.from < a.to)
    .sort((a, b) => a.from - b.from || a.to - b.to);
  const builder = new RangeSetBuilder<Decoration>();
  for (const a of valid) {
    builder.add(
      a.from,
      a.to,
      Decoration.mark({
        class: `anchor anchor-${a.kind}${a.active ? ' anchor-active' : ''}`,
        attributes: { 'data-anchor-id': a.id },
      }),
    );
  }
  return builder.finish();
}

const annotationsField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setAnnotations)) {
        deco = buildDecorations(effect.value, tr.state.doc.length);
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const markdownHighlight = HighlightStyle.define([
  { tag: t.heading1, class: 'md-h1' },
  { tag: t.heading2, class: 'md-h2' },
  { tag: t.heading3, class: 'md-h3' },
  { tag: t.heading4, class: 'md-h4' },
  { tag: t.strong, class: 'md-strong' },
  { tag: t.emphasis, class: 'md-em' },
  { tag: t.strikethrough, class: 'md-strike' },
  { tag: t.link, class: 'md-link' },
  { tag: t.url, class: 'md-url' },
  { tag: t.monospace, class: 'md-code' },
  { tag: t.quote, class: 'md-quote' },
  { tag: t.processingInstruction, class: 'md-mark' },
  { tag: t.meta, class: 'md-mark' },
  { tag: t.contentSeparator, class: 'md-hr' },
]);

export const readOnlyCompartment = new Compartment();

export interface EditorCallbacks {
  onChange: (content: string, changes: import('@codemirror/state').ChangeDesc) => void;
  onSelectionChange: (sel: { from: number; to: number } | null) => void;
  onAnchorClick: (id: string) => void;
}

export function createExtensions(callbacks: EditorCallbacks) {
  return [
    history(),
    // Native caret (blinks; drawSelection's layer-drawn cursor didn't) —
    // selection styling comes from ::selection / caret-color in styles.css.
    highlightSelectionMatches(),
    EditorState.allowMultipleSelections.of(true),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
    markdown({ base: markdownLanguage }),
    syntaxHighlighting(markdownHighlight),
    EditorView.lineWrapping,
    placeholder('Write…'),
    annotationsField,
    readOnlyCompartment.of(EditorState.readOnly.of(false)),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        callbacks.onChange(update.state.doc.toString(), update.changes);
      }
      if (update.selectionSet) {
        const range = update.state.selection.main;
        callbacks.onSelectionChange(range.empty ? null : { from: range.from, to: range.to });
      }
    }),
    EditorView.domEventHandlers({
      mousedown: (event) => {
        const target = (event.target as HTMLElement).closest('[data-anchor-id]');
        if (target) callbacks.onAnchorClick(target.getAttribute('data-anchor-id')!);
        return false;
      },
    }),
  ];
}
