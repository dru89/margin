import { EditorView } from '@codemirror/view';
import { Transaction } from '@codemirror/state';
import { formatTableAt } from '@/editor/extensions';

/** One editor per window; a module-level handle keeps store actions simple. */
let view: EditorView | null = null;

export function setEditorView(v: EditorView | null): void {
  view = v;
}

export function getEditorView(): EditorView | null {
  return view;
}

/**
 * Replace a range through the editor so every other anchor remaps.
 *
 * `addToHistory: false` is for edits that are really *decisions* — accepting
 * a suggestion, say. Those are recorded in the review as well as the text,
 * and only the text half is undoable by Cmd-Z, so leaving them on the undo
 * stack lets the two drift apart silently (#128). A decision is undone as a
 * decision instead.
 */
export function applyReplacement(
  from: number,
  to: number,
  insert: string,
  opts: { addToHistory?: boolean } = {},
): void {
  view?.dispatch({
    changes: { from, to, insert },
    ...(opts.addToHistory === false
      ? { annotations: [Transaction.addToHistory.of(false)] }
      : {}),
  });
}

/** Format the table under the caret (context-menu entry point). */
export function formatTableAtCaret(): void {
  if (view) formatTableAt(view, view.state.selection.main.head);
}

/**
 * Take the reader to a passage: select it, center it, and glide rather
 * than jump.
 *
 * Symmetric with going the other way. Clicking marked text centers its
 * card and eases into place; clicking the card used to snap the document
 * to a position 96px from the top, so the same relationship behaved
 * differently depending on which end you started from.
 *
 * CodeMirror's own `scrollIntoView` is instant, so the scroller is driven
 * directly to keep the motion.
 */
export function revealRange(from: number, to: number): void {
  if (!view) return;
  const len = view.state.doc.length;
  const a = Math.min(from, len);
  const b = Math.min(to, len);
  view.dispatch({ selection: { anchor: a, head: b } });
  view.focus();
  const scroller = view.scrollDOM;
  const coords = view.coordsAtPos(a);
  if (!coords) {
    view.dispatch({ effects: EditorView.scrollIntoView(a, { y: 'center' }) });
    return;
  }
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const top =
    scroller.scrollTop + coords.top - scroller.getBoundingClientRect().top - scroller.clientHeight / 2;
  scroller.scrollTo({ top: Math.max(0, top), behavior: still ? 'auto' : 'smooth' });
}
