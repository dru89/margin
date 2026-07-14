import { useEffect, useMemo, useRef } from 'react';
import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { useLocked, useStore } from '@/store';
import { setEditorView } from '@/editorBridge';
import {
  createExtensions,
  readOnlyCompartment,
  setAnnotations,
  type EditorAnnotation,
} from '@/editor/extensions';

export function EditorPane() {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const filePath = useStore((s) => s.doc?.filePath);
  const loadedAt = useStore((s) => s.doc?.loadedAt);
  const review = useStore((s) => s.review);
  const activeAnchorId = useStore((s) => s.activeAnchorId);
  const hoveredAnchorId = useStore((s) => s.hoveredAnchorId);
  const locked = useLocked();

  // Create the editor once per document.
  useEffect(() => {
    if (!containerRef.current) return;
    const {
      content,
      handleDocChange,
      setSelection,
      setActiveAnchor,
      setHoveredAnchor,
      acceptSuggestion,
      rejectSuggestion,
    } = useStore.getState();
    let lastCaretInTable = false; // per-editor; a fresh session starts false too
    const view = new EditorView({
      state: EditorState.create({
        doc: content,
        extensions: createExtensions({
          onChange: handleDocChange,
          onSelectionChange: setSelection,
          onAnchorClick: setActiveAnchor,
          onAnchorHover: setHoveredAnchor,
          onSuggestionAction: (id, action) => {
            if (useStore.getState().agent.phase === 'running') return;
            if (action === 'accept') acceptSuggestion(id);
            else rejectSuggestion(id);
          },
          onCaretInTable: (inTable) => {
            if (inTable !== lastCaretInTable) {
              lastCaretInTable = inTable;
              window.margin.setCaretContext({ inTable });
            }
          },
        }),
      }),
      parent: containerRef.current,
    });
    viewRef.current = view;
    setEditorView(view);
    return () => {
      setEditorView(null);
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, loadedAt]);

  // Esc unpins the active pair (spec §2).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') useStore.getState().setActiveAnchor(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const annotations = useMemo<EditorAnnotation[]>(() => {
    if (!review) return [];
    const anns: EditorAnnotation[] = [];
    for (const c of review.comments) {
      if (c.status === 'open' && !c.anchor.orphaned) {
        anns.push({
          id: c.id,
          from: c.anchor.from,
          to: c.anchor.to,
          kind: 'comment',
          active: c.id === activeAnchorId,
          hot: c.id === hoveredAnchorId,
        });
      }
    }
    for (const s of review.suggestions) {
      if (s.status === 'pending' && !s.anchor.orphaned) {
        anns.push({
          id: s.id,
          from: s.anchor.from,
          to: s.anchor.to,
          kind: 'suggestion',
          replacement: s.replacement,
          active: s.id === activeAnchorId,
          hot: s.id === hoveredAnchorId,
        });
      }
    }
    return anns;
  }, [review, activeAnchorId, hoveredAnchorId]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: setAnnotations.of(annotations) });
  }, [annotations]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(locked)),
    });
  }, [locked]);

  return <div className="editor-pane" ref={containerRef} />;
}
