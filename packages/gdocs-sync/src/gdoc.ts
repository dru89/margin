/**
 * Minimal Docs/Drive API surface: the request/document shapes we use,
 * a client interface the orchestrator depends on, an HTTP client for
 * the live tier, and a fake for the offline orchestrator tier
 * (USCOPE-*). Quota retry wraps the one choke point (lesson 10).
 */
import { withQuotaRetry } from './util.ts';

/* ——— document read shapes (subset) ——— */

export interface GDocTextRun {
  textRun?: {
    content?: string;
    textStyle?: {
      bold?: boolean;
      italic?: boolean;
      strikethrough?: boolean;
      link?: { url?: string };
      weightedFontFamily?: { fontFamily?: string };
    };
  };
}

export interface GDocParagraph {
  elements?: GDocTextRun[];
  paragraphStyle?: {
    namedStyleType?: string;
    indentStart?: { magnitude?: number; unit?: string };
    borderBottom?: { width?: { magnitude?: number } };
  };
  bullet?: { listId?: string; nestingLevel?: number };
}

export interface GDocStructuralElement {
  startIndex?: number;
  endIndex?: number;
  paragraph?: GDocParagraph;
  table?: {
    rows?: number;
    columns?: number;
    tableRows?: { tableCells?: { content?: GDocStructuralElement[] }[] }[];
  };
  sectionBreak?: unknown;
}

export interface GDocDocument {
  documentId?: string;
  revisionId?: string;
  body?: { content?: GDocStructuralElement[] };
  lists?: Record<string, { listProperties?: { nestingLevels?: { glyphType?: string }[] } }>;
}

/* ——— request shapes (subset we emit) ——— */

export type GDocRequest = Record<string, unknown>;

export interface DocsClient {
  createDocument(title: string): Promise<{ documentId: string }>;
  getDocument(docId: string): Promise<GDocDocument>;
  batchUpdate(docId: string, requests: GDocRequest[], requiredRevisionId?: string): Promise<void>;
}

/* ——— live HTTP client ——— */

const DOCS = 'https://docs.googleapis.com/v1/documents';

export class HttpDocsClient implements DocsClient {
  private readonly token: () => Promise<string>;

  constructor(token: () => Promise<string>) {
    this.token = token;
  }

  private async call<T>(url: string, init?: RequestInit): Promise<T> {
    return withQuotaRetry(async () => {
      const res = await fetch(url, {
        ...init,
        headers: {
          authorization: `Bearer ${await this.token()}`,
          'content-type': 'application/json',
          ...init?.headers,
        },
      });
      if (!res.ok) {
        const err = new Error(`${init?.method ?? 'GET'} ${url} → ${res.status}: ${await res.text()}`);
        (err as unknown as { status: number }).status = res.status;
        throw err;
      }
      return (await res.json()) as T;
    });
  }

  createDocument(title: string): Promise<{ documentId: string }> {
    return this.call(DOCS, { method: 'POST', body: JSON.stringify({ title }) });
  }

  getDocument(docId: string): Promise<GDocDocument> {
    return this.call(`${DOCS}/${docId}`);
  }

  async batchUpdate(docId: string, requests: GDocRequest[], requiredRevisionId?: string): Promise<void> {
    if (requests.length === 0) return;
    await this.call(`${DOCS}/${docId}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({
        requests,
        ...(requiredRevisionId ? { writeControl: { requiredRevisionId } } : {}),
      }),
    });
  }
}

/* ——— fake client for USCOPE tests ——— */

export class FakeDocsClient implements DocsClient {
  public batches: GDocRequest[][] = [];
  private readonly docs: Map<string, GDocDocument> | GDocDocument;

  constructor(docs: Map<string, GDocDocument> | GDocDocument) {
    this.docs = docs;
  }

  async createDocument(): Promise<{ documentId: string }> {
    return { documentId: 'fake-doc' };
  }

  async getDocument(docId: string): Promise<GDocDocument> {
    if (this.docs instanceof Map) {
      const doc = this.docs.get(docId);
      if (!doc) throw new Error(`fake: no doc ${docId}`);
      return doc;
    }
    return this.docs;
  }

  async batchUpdate(_docId: string, requests: GDocRequest[]): Promise<void> {
    if (requests.length > 0) this.batches.push(requests);
  }

  get requestCount(): number {
    return this.batches.reduce((n, b) => n + b.length, 0);
  }
}
