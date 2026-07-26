/**
 * `@path` file references in comment text (spec §9, #90).
 *
 * Stored as plain text, always. The reference travels to the agent and
 * back through a round unchanged, and a sidecar stays readable in a text
 * editor — both of which stop being true the moment the chip becomes a
 * structure with an id in it. Rendering is the renderer's business; this
 * module only says where the references are.
 */

export interface MentionPart {
  kind: 'text' | 'file';
  /** For a file part, the normalized workspace-relative path. */
  value: string;
  /** For a file part, the source text it was written as, chip label. */
  raw?: string;
}

/**
 * Punctuation a sentence can end with, trimmed off the end of a path.
 *
 * "See @docs/plan.md." is ordinary prose and the period is not part of
 * the filename. Closing brackets and quotes come along for the same
 * reason — a reference inside parentheses is common and the paren is
 * never the file. A path that is *only* punctuation is not a reference.
 */
const TRAILING = /[.,;:!?)\]}>'"»’”›]+$/;

/**
 * What may *not* sit immediately before the `@`.
 *
 * This is the email guard, and it has to be stated as an exclusion rather
 * than as "start or whitespace": a reference is often written inside
 * brackets or quotes, and `(@docs/plan.md)` is unmistakably a reference.
 * What is never one is an `@` continuing a word — which is exactly the
 * shape of `drew@hays.fm`. A second `@` is excluded too, since the path
 * that follows it would be anyone's guess.
 */
const MENTION = /(?<![\w.%+@-])@([^\s@]+)/g;

/**
 * Normalize what someone typed into a key the workspace can be searched
 * with: a path relative to the project root, forward slashes, no leading
 * separator and no `./`.
 *
 * Deliberately not a security check. Anything that fails to name a file
 * the workspace scan actually found renders as a lost reference and is
 * not clickable, which covers `..`, absolute paths, and everything else
 * outside the project without this function needing to reason about it.
 */
export function normalizeMentionPath(raw: string): string {
  let rel = raw.replace(/\\/g, '/').replace(/^\/+/, '');
  while (rel.startsWith('./')) rel = rel.slice(2);
  return rel;
}

/**
 * Split text into prose and file references, in order. Concatenating
 * every part's `raw ?? value` reproduces the input exactly — the chip is
 * a rendering of the text, never a replacement for it.
 */
export function splitMentions(text: string): MentionPart[] {
  const parts: MentionPart[] = [];
  let last = 0;
  for (const m of text.matchAll(MENTION)) {
    const start = m.index;
    const body = m[1].replace(TRAILING, '');
    if (!body) continue; // "@..." — punctuation only, not a reference
    if (start > last) parts.push({ kind: 'text', value: text.slice(last, start) });
    parts.push({ kind: 'file', value: normalizeMentionPath(body), raw: `@${body}` });
    last = start + 1 + body.length;
  }
  if (last < text.length) parts.push({ kind: 'text', value: text.slice(last) });
  return parts;
}
