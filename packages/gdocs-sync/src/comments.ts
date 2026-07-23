/**
 * Typed surface over the Drive comments API (issue #25). Reads are the
 * primary use (Margin's sidebar, the CLI's comments output); the only
 * upstream writes are reply and resolve-via-reply — creating
 * *positioned* comments is unsupported (the anchor format is opaque
 * and unstable, lesson 6), and this module deliberately offers no
 * comment creation at all.
 *
 * Token-in like the rest of the library: no auth opinions. Anchor
 * *positions* are API-invisible; `quotedText` is the anchoring signal
 * consumers get (it maps onto Margin's quote+context re-anchoring).
 */
import { withQuotaRetry } from './util.ts';

export interface CommentAuthor {
  displayName: string;
  /** True when the authenticated user wrote it. */
  me: boolean;
}

export interface CommentReply {
  id: string;
  content: string;
  author: CommentAuthor;
  createdTime: string;
  /** 'resolve' | 'reopen' when the reply changed thread state. */
  action?: string;
}

export interface CommentRecord {
  id: string;
  content: string;
  author: CommentAuthor;
  /** The anchored text at comment time — null on unanchored comments. */
  quotedText: string | null;
  /** An anchor exists (its position is opaque; orphaned and healthy look identical). */
  anchored: boolean;
  resolved: boolean;
  createdTime: string;
  modifiedTime: string;
  replies: CommentReply[];
}

const COMMENT_FIELDS =
  'id,content,author(displayName,me),quotedFileContent(value),resolved,anchor,deleted,createdTime,modifiedTime,' +
  'replies(id,content,author(displayName,me),action,createdTime,deleted)';

interface RawReply {
  id: string;
  content?: string;
  author?: { displayName?: string; me?: boolean };
  action?: string;
  createdTime: string;
  deleted?: boolean;
}

interface RawComment {
  id: string;
  content?: string;
  author?: { displayName?: string; me?: boolean };
  quotedFileContent?: { value?: string };
  resolved?: boolean;
  anchor?: string;
  deleted?: boolean;
  createdTime: string;
  modifiedTime?: string;
  replies?: RawReply[];
}

function authorOf(raw?: { displayName?: string; me?: boolean }): CommentAuthor {
  return { displayName: raw?.displayName ?? 'Unknown', me: raw?.me ?? false };
}

function recordOf(raw: RawComment): CommentRecord {
  return {
    id: raw.id,
    content: raw.content ?? '',
    author: authorOf(raw.author),
    quotedText: raw.quotedFileContent?.value ?? null,
    anchored: typeof raw.anchor === 'string' && raw.anchor.length > 0,
    resolved: raw.resolved ?? false,
    createdTime: raw.createdTime,
    modifiedTime: raw.modifiedTime ?? raw.createdTime,
    replies: (raw.replies ?? [])
      .filter((r) => !r.deleted)
      .map((r) => ({
        id: r.id,
        content: r.content ?? '',
        author: authorOf(r.author),
        createdTime: r.createdTime,
        ...(r.action !== undefined ? { action: r.action } : {}),
      })),
  };
}

async function driveFetch<T>(
  getToken: () => Promise<string>,
  fetchImpl: typeof fetch,
  path: string,
  init?: RequestInit,
): Promise<T> {
  return withQuotaRetry(async () => {
    const res = await fetchImpl(`https://www.googleapis.com/drive/v3/files/${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${await getToken()}`,
        'content-type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      const err = new Error(`drive comments ${init?.method ?? 'GET'} ${path} → ${res.status}: ${await res.text()}`);
      (err as unknown as { status: number }).status = res.status;
      throw err;
    }
    return (await res.json()) as T;
  });
}

/**
 * All comment threads on a file, paginated. Returns null when the
 * comments endpoint itself is denied (403/404 can occur independent of
 * file access — callers must treat "unavailable" differently from
 * "none", lesson 6). Deleted comments are excluded.
 */
export async function fetchComments(
  getToken: () => Promise<string>,
  fileId: string,
  options: { unresolvedOnly?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<CommentRecord[] | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const records: CommentRecord[] = [];
  let pageToken: string | undefined;
  try {
    do {
      const params = new URLSearchParams({
        fields: `nextPageToken,comments(${COMMENT_FIELDS})`,
        pageSize: '100',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const page = await driveFetch<{ nextPageToken?: string; comments?: RawComment[] }>(
        getToken,
        fetchImpl,
        `${fileId}/comments?${params}`,
      );
      for (const raw of page.comments ?? []) {
        if (raw.deleted) continue;
        records.push(recordOf(raw));
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 403 || status === 404) return null;
    throw err;
  }
  return options.unresolvedOnly ? records.filter((r) => !r.resolved) : records;
}

/** Reply to an existing thread, as the authenticated user, verbatim. */
export async function replyToComment(
  getToken: () => Promise<string>,
  fileId: string,
  commentId: string,
  content: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<CommentReply> {
  const raw = await driveFetch<RawReply>(
    getToken,
    options.fetchImpl ?? fetch,
    `${fileId}/comments/${commentId}/replies?fields=id,content,author(displayName,me),action,createdTime`,
    { method: 'POST', body: JSON.stringify({ content }) },
  );
  return {
    id: raw.id,
    content: raw.content ?? '',
    author: authorOf(raw.author),
    createdTime: raw.createdTime,
    ...(raw.action !== undefined ? { action: raw.action } : {}),
  };
}

/** Resolve a thread via an action reply (the only supported mechanism). */
export async function resolveComment(
  getToken: () => Promise<string>,
  fileId: string,
  commentId: string,
  content = '',
  options: { fetchImpl?: typeof fetch } = {},
): Promise<void> {
  await driveFetch(
    getToken,
    options.fetchImpl ?? fetch,
    `${fileId}/comments/${commentId}/replies?fields=id,action`,
    { method: 'POST', body: JSON.stringify({ action: 'resolve', content }) },
  );
}

// ————— Markdown emission (issue #52: the fetch/CLI surface) —————

import { COMMENTS_END, COMMENTS_START } from './markdown.ts';

/** Human-readable thread list (no markers) — the `gdocs comments` output. */
export function commentsAsMarkdown(records: CommentRecord[]): string {
  if (records.length === 0) return 'No comments.\n';
  const parts: string[] = [];
  for (const r of records) {
    const anchor = r.quotedText ? ` on “${r.quotedText.replace(/\s+/g, ' ').trim()}”` : '';
    parts.push(`**${r.author.displayName}**${anchor} — ${r.resolved ? 'resolved' : 'open'}\n`);
    const quote = [`> ${r.content.replace(/\n/g, '\n> ')}`];
    for (const reply of r.replies) {
      if (reply.content === '' && reply.action) continue; // bare action replies carry no text
      quote.push('>');
      quote.push(`> **${reply.author.displayName}** replied: ${reply.content.replace(/\n/g, '\n> ')}`);
    }
    parts.push(quote.join('\n') + '\n');
  }
  return parts.join('\n');
}

/**
 * The `## Comments` section appended to fetched markdown, wrapped in
 * the gpush markers — push strips exactly this (UMISC-1), so
 * fetch → edit → push round-trips cleanly.
 */
export function commentsSection(records: CommentRecord[]): string {
  if (records.length === 0) return '';
  return `\n${COMMENTS_START}\n\n## Comments\n\n${commentsAsMarkdown(records)}\n${COMMENTS_END}\n`;
}
