import {
  Decoration,
  EditorView,
  WidgetType,
  keymap,
  placeholder,
  type DecorationSet,
} from '@codemirror/view';
import {
  EditorState,
  RangeSetBuilder,
  StateEffect,
  StateField,
  Compartment,
} from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { tags as t } from '@lezer/highlight';

export interface EditorAnnotation {
  id: string;
  from: number;
  to: number;
  kind: 'comment' | 'suggestion';
  /** Suggestions render inline: original struck through, replacement after. */
  replacement?: string;
  /** Pinned (clicked) — the spec's "active" step. */
  active: boolean;
  /** Hovered on either side of the pair — the spec's "hot" step. */
  hot: boolean;
}

export const setAnnotations = StateEffect.define<EditorAnnotation[]>();

function pairClasses(a: EditorAnnotation): string {
  return `${a.active ? ' pair-active' : ''}${a.hot ? ' pair-hot' : ''}`;
}

/**
 * Markdown context classes at a position (heading level, emphasis), so the
 * inserted half of an inline suggestion renders like the text it replaces.
 */
function contextClasses(state: EditorState, pos: number): string {
  let classes = '';
  const tree = syntaxTree(state);
  let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(pos, 1);
  while (node) {
    const m = /^(ATXHeading|SetextHeading)([1-6])/.exec(node.name);
    if (m) classes += ` md-h${m[2]}`;
    if (node.name === 'StrongEmphasis') classes += ' md-strong';
    if (node.name === 'Emphasis') classes += ' md-em';
    if (node.name === 'Blockquote') classes += ' md-quote';
    node = node.parent;
  }
  return classes;
}

/**
 * The inserted-text half of an inline suggestion, with the in-situ
 * accept/reject pill (spec §3). Buttons carry data-action; the editor's
 * mousedown handler routes them.
 */
class ReplacementWidget extends WidgetType {
  constructor(
    private readonly id: string,
    private readonly text: string,
    private readonly stateClasses: string,
    private readonly mdClasses: string,
  ) {
    super();
  }

  eq(other: ReplacementWidget): boolean {
    return (
      other.id === this.id &&
      other.text === this.text &&
      other.stateClasses === this.stateClasses &&
      other.mdClasses === this.mdClasses
    );
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = `suggest-ins-wrap${this.stateClasses}`;
    wrap.dataset.anchorId = this.id;

    const ins = document.createElement('span');
    ins.className = `anchor anchor-suggestion-ins${this.mdClasses}${this.stateClasses}`;
    ins.dataset.anchorId = this.id;
    ins.textContent = this.text;
    wrap.appendChild(ins);

    const pill = document.createElement('span');
    pill.className = 'suggest-pill';
    const accept = document.createElement('button');
    accept.className = 'pill-accept';
    accept.textContent = 'Accept';
    accept.dataset.anchorId = this.id;
    accept.dataset.action = 'accept';
    const reject = document.createElement('button');
    reject.className = 'pill-reject';
    reject.textContent = 'Reject';
    reject.dataset.anchorId = this.id;
    reject.dataset.action = 'reject';
    pill.append(accept, reject);
    wrap.appendChild(pill);
    return wrap;
  }

  ignoreEvent(): boolean {
    return false; // route clicks through the editor's dom handlers
  }
}

function buildDecorations(annotations: EditorAnnotation[], state: EditorState): DecorationSet {
  const docLength = state.doc.length;
  const valid = annotations
    .map((a) => ({ ...a, from: Math.max(0, a.from), to: Math.min(a.to, docLength) }))
    .filter((a) => a.from < a.to)
    .sort((a, b) => a.from - b.from || a.to - b.to);
  const builder = new RangeSetBuilder<Decoration>();
  let lastEnd = -1;
  for (const a of valid) {
    if (a.from < lastEnd) continue; // overlapping anchors: first one wins
    const stateCls = pairClasses(a);
    if (a.kind === 'suggestion') {
      builder.add(
        a.from,
        a.to,
        Decoration.mark({
          class: `anchor anchor-suggestion-del${stateCls}`,
          attributes: { 'data-anchor-id': a.id },
        }),
      );
      if (a.replacement) {
        builder.add(
          a.to,
          a.to,
          Decoration.widget({
            widget: new ReplacementWidget(a.id, a.replacement, stateCls, contextClasses(state, a.from)),
            side: 1,
          }),
        );
      }
    } else {
      builder.add(
        a.from,
        a.to,
        Decoration.mark({
          class: `anchor anchor-comment${stateCls}`,
          attributes: { 'data-anchor-id': a.id },
        }),
      );
    }
    lastEnd = a.to;
  }
  return builder.finish();
}

const annotationsField = StateField.define<{ anns: EditorAnnotation[]; deco: DecorationSet }>({
  create: () => ({ anns: [], deco: Decoration.none }),
  update(value, tr) {
    let { anns, deco } = value;
    deco = deco.map(tr.changes);
    let rebuilt = false;
    for (const effect of tr.effects) {
      if (effect.is(setAnnotations)) {
        anns = effect.value;
        rebuilt = true;
      }
    }
    if (rebuilt || tr.docChanged) {
      deco = buildDecorations(anns, tr.state);
    }
    return { anns, deco };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
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
  onAnchorClick: (id: string | null) => void;
  onAnchorHover: (id: string | null) => void;
  onSuggestionAction: (id: string, action: 'accept' | 'reject') => void;
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
        const el = event.target as HTMLElement;
        const action = el.closest<HTMLElement>('[data-action]');
        if (action) {
          event.preventDefault();
          callbacks.onSuggestionAction(
            action.dataset.anchorId!,
            action.dataset.action as 'accept' | 'reject',
          );
          return true;
        }
        const target = el.closest<HTMLElement>('[data-anchor-id]');
        callbacks.onAnchorClick(target?.dataset.anchorId ?? null);
        return false;
      },
      mouseover: (event) => {
        const target = (event.target as HTMLElement).closest<HTMLElement>('[data-anchor-id]');
        if (target) callbacks.onAnchorHover(target.dataset.anchorId!);
        return false;
      },
      mouseout: (event) => {
        const target = (event.target as HTMLElement).closest<HTMLElement>('[data-anchor-id]');
        if (target) callbacks.onAnchorHover(null);
        return false;
      },
    }),
  ];
}
