import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AnchorHTMLAttributes } from 'react';
import { splitMentions } from '@shared/mentions';
import { useStore } from '@/store';

/**
 * `@path` references render as chips (spec §9, #90).
 *
 * A chip resolves against the workspace file list and nothing else. That
 * is what confines references to the project without a path check of its
 * own: the scan is rooted at the project root, so a reference to anything
 * outside it — `../secrets.md`, `/etc/passwd` — simply names no file and
 * renders as lost. The agent writes these too, which is why "is it in the
 * list" is the whole rule rather than "does it exist on disk".
 */
const FILE_SCHEME = 'margin-file:';

/**
 * Turn `@path` inside text into link nodes carrying the path.
 *
 * A link is used because it is a node type react-markdown already routes
 * through `components`, so no custom node plumbing is needed. Only `text`
 * nodes are visited, which is what keeps a literal `@path` inside
 * backticks as literal text — code content is not a text node.
 */
function remarkFileChips() {
  return (tree: { children?: unknown[] }): void => {
    const walk = (node: { children?: unknown[] }): void => {
      const children = node.children;
      if (!Array.isArray(children)) return;
      const next: unknown[] = [];
      for (const child of children) {
        const c = child as { type?: string; value?: string; children?: unknown[] };
        if (c.type === 'text' && typeof c.value === 'string') {
          const parts = splitMentions(c.value);
          if (parts.some((p) => p.kind === 'file')) {
            for (const p of parts) {
              next.push(
                p.kind === 'file'
                  ? {
                      type: 'link',
                      url: `${FILE_SCHEME}${encodeURIComponent(p.value)}`,
                      children: [{ type: 'text', value: p.raw }],
                    }
                  : { type: 'text', value: p.value },
              );
            }
            continue;
          }
        }
        if (c.type !== 'link') walk(c); // never nest a chip inside a link
        next.push(child);
      }
      node.children = next;
    };
    walk(tree);
  };
}

/**
 * A file reference. Clicking follows the explorer's rule, so a file
 * behaves the same wherever it is named: markdown opens in Margin,
 * anything else opens in whatever the desktop uses for it. A reference
 * that names no file in the project is not clickable and says so.
 */
function FileChip({ rel, label }: { rel: string; label: string }) {
  const workspace = useStore((s) => s.workspace);
  const switchToFile = useStore((s) => s.switchToFile);
  const file = workspace?.files.find((f) => f.rel === rel);

  if (!file) {
    return (
      <span className="file-chip file-chip-lost" title={`${rel} — not in this project`}>
        {label}
      </span>
    );
  }
  const markdown = file.kind === 'markdown';
  return (
    <button
      className="file-chip"
      title={markdown ? file.rel : `${file.rel} — opens in its default app`}
      onClick={(e) => {
        e.stopPropagation(); // the card underneath focuses its anchor
        if (markdown) void switchToFile(file.path);
        else void window.margin.openExternal(file.path);
      }}
    >
      {label}
    </button>
  );
}

function Anchor({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  if (href?.startsWith(FILE_SCHEME)) {
    const rel = decodeURIComponent(href.slice(FILE_SCHEME.length));
    return <FileChip rel={rel} label={String(children)} />;
  }
  return (
    <a href={href} {...rest}>
      {children}
    </a>
  );
}

/** Compact markdown rendering for sidebar text (agent replies are markdown). */
export function Md({ text }: { text: string }) {
  return (
    <div className="md-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkFileChips]}
        // The default transform drops unknown schemes, which would strip
        // every chip. Real links keep the default's protection.
        urlTransform={(url) => (url.startsWith(FILE_SCHEME) ? url : defaultUrlTransform(url))}
        components={{ a: Anchor }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
