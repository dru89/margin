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
  const review = useStore((s) => s.review);
  const activeAnchorId = useStore((s) => s.activeAnchorId);
  const locked = useLocked();

  // Create the editor once per document.
  useEffect(() => {
    if (!containerRef.current) return;
    const { content, handleDocChange, setSelection, setActiveAnchor } = useStore.getState();
    const view = new EditorView({
      state: EditorState.create({
        doc: content,
        extensions: createExtensions({
          onChange: handleDocChange,
          onSelectionChange: setSelection,
          onAnchorClick: setActiveAnchor,
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
  }, [filePath]);

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
        });
      }
    }
    return anns;
  }, [review, activeAnchorId]);

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
