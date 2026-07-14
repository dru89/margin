import { EditorView } from '@codemirror/view';
import { formatTableAt } from '@/editor/extensions';

/** One editor per window; a module-level handle keeps store actions simple. */
let view: EditorView | null = null;

export function setEditorView(v: EditorView | null): void {
  view = v;
}

export function getEditorView(): EditorView | null {
  return view;
}

export function applyReplacement(from: number, to: number, insert: string): void {
  view?.dispatch({ changes: { from, to, insert } });
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
