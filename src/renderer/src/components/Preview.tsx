import { useEffect, useMemo, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useStore } from '@/store';

/** Split a leading YAML frontmatter block from the document body (issue #4). */
function splitFrontmatter(content: string): { fields: [string, string][] | null; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(content);
  if (!m) return { fields: null, body: content };
  const fields: [string, string][] = [];
  for (const line of m[1].split('\n')) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) fields.push([kv[1], kv[2].replace(/^["']|["']$/g, '')]);
    else if (line.trim() && fields.length > 0) {
      // continuation (multiline values, list items) — append to previous
      fields[fields.length - 1][1] += ` ${line.trim()}`;
    }
  }
  return { fields, body: content.slice(m[0].length) };
}

/**
 * Preview with comment/suggestion highlights. Rendered markdown loses source
 * offsets, so anchors are re-located by quote text in the DOM: for each open
 * item we find its quote within the rendered text nodes and wrap it. Quotes
 * that cross inline formatting boundaries (e.g. a quote spanning **bold**)
 * aren't highlighted here — they remain fully visible in the sidebar.
 */
export function Preview() {
  const content = useStore((s) => s.content);
  const review = useStore((s) => s.review);
  const activeAnchorId = useStore((s) => s.activeAnchorId);
  const setActiveAnchor = useStore((s) => s.setActiveAnchor);
  const setPreviewQuote = useStore((s) => s.setPreviewQuote);
  const ref = useRef<HTMLDivElement>(null);
  const fm = useMemo(() => splitFrontmatter(content), [content]);

  const anchors = useMemo(() => {
    if (!review) return [];
    return [
      ...review.comments
        .filter((c) => c.status === 'open' && !c.anchor.orphaned)
        .map((c) => ({ id: c.id, quote: c.anchor.quote, kind: 'comment' as const })),
      ...review.suggestions
        .filter((s) => s.status === 'pending' && !s.anchor.orphaned)
        .map((s) => ({ id: s.id, quote: s.anchor.quote, kind: 'suggestion' as const })),
    ];
  }, [review]);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    for (const anchor of anchors) {
      const quote = anchor.quote.trim();
      if (!quote || root.querySelector(`[data-anchor-id="${anchor.id}"]`)) continue;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const idx = node.textContent?.indexOf(quote) ?? -1;
        if (idx === -1) continue;
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + quote.length);
        const mark = document.createElement('span');
        mark.className = `anchor anchor-${anchor.kind}`;
        mark.dataset.anchorId = anchor.id;
        try {
          range.surroundContents(mark);
        } catch {
          /* crosses element boundaries — skip */
        }
        break;
      }
    }
    // Reflect the active card.
    for (const el of root.querySelectorAll<HTMLElement>('[data-anchor-id]')) {
      el.classList.toggle('anchor-active', el.dataset.anchorId === activeAnchorId);
    }
  });

  return (
    <div className="preview-pane">
      <article
        className="preview-body"
        ref={ref}
        // Force a full remount when content changes so our DOM wrapping never
        // fights React's reconciliation of the markdown tree.
        key={content}
        onClick={(e) => {
          const hit = (e.target as HTMLElement).closest<HTMLElement>('[data-anchor-id]');
          if (hit) setActiveAnchor(hit.dataset.anchorId!);
        }}
        onMouseUp={() => setPreviewQuote(window.getSelection()?.toString() ?? null)}
      >
        {fm.fields && (
          <aside className="frontmatter-card">
            <dl>
              {fm.fields.map(([k, v]) => (
                <div key={k} style={{ display: 'contents' }}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          </aside>
        )}
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{fm.body}</ReactMarkdown>
      </article>
    </div>
  );
}
