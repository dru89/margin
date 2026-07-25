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

export function revealRange(from: number, to: number): void {
  if (!view) return;
  const len = view.state.doc.length;
  const a = Math.min(from, len);
  const b = Math.min(to, len);
  view.dispatch({
    selection: { anchor: a, head: b },
    // Spec §2 scroll choreography: anchor lands 96px from the top.
    effects: EditorView.scrollIntoView(a, { y: 'start', yMargin: 96 }),
  });
  view.focus();
}
