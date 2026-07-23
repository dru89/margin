/**
 * Multi-tab orchestration: reconcile a set of markdown inputs against
 * a document's top-level tabs (UTAB plan → addDocumentTab / rename /
 * delete / reorder), then sync each tab's content with the existing
 * single-tab machinery.
 *
 * Mechanics (lessons 2/7): per-tab write requests need the tab ID in
 * every location/range — `withTabId` injects it recursively so the
 * builder stays tab-agnostic; tab reorders are one batchUpdate per
 * move (batched moves apply against the initial order, silently
 * wrong); reading tab content requires includeTabsContent=true.
 */
import type { DocsClient, GDocDocument, GDocRequest } from './gdoc.ts';
import { planTabs } from './tabs.ts';
import { truncateTabTitle } from './util.ts';
import { updateFromMarkdown, type SyncOptions, type UpdatePlan } from './sync.ts';
import { emitFrontmatter, parseDocMeta } from './meta.ts';
import { docToBlocks } from './reader.ts';
import { serializeBlocks } from './serialize.ts';

export interface TabInput {
  title: string;
  markdown: string;
}

interface TabShape {
  tabProperties?: { tabId?: string; title?: string; index?: number };
  documentTab?: {
    body?: GDocDocument['body'];
    lists?: GDocDocument['lists'];
    inlineObjects?: GDocDocument['inlineObjects'];
  };
  childTabs?: TabShape[];
}

interface TabbedDoc extends GDocDocument {
  tabs?: TabShape[];
}

/** Recursively inject tabId into every location/range of a request tree. */
export function withTabId<T>(value: T, tabId: string): T {
  if (Array.isArray(value)) return value.map((v) => withTabId(v, tabId)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = withTabId(v, tabId);
    }
    if ('index' in out || 'startIndex' in out || 'segmentId' in out) out.tabId = tabId;
    return out as T;
  }
  return value;
}

/** Present one tab as a plain GDocDocument for the reader/differ. */
function tabView(doc: TabbedDoc, tabId: string): GDocDocument {
  const tab = (doc.tabs ?? []).find((t) => t.tabProperties?.tabId === tabId);
  if (!tab?.documentTab) throw new Error(`tab ${tabId} not found`);
  return {
    documentId: doc.documentId,
    revisionId: doc.revisionId,
    body: tab.documentTab.body,
    lists: tab.documentTab.lists,
    inlineObjects: tab.documentTab.inlineObjects,
  };
}

/** A DocsClient view scoped to one tab: reads see the tab, writes carry its id. */
function tabClient(client: DocsClient, tabId: string): DocsClient {
  return {
    createDocument: (title) => client.createDocument(title),
    getDocument: async (docId, viewMode) => {
      const doc = (await (
        client as DocsClient & { getDocumentWithTabs?: typeof client.getDocument }
      ).getDocumentWithTabs?.(docId, viewMode)) as TabbedDoc | undefined;
      if (!doc) throw new Error('client does not support tab reads (getDocumentWithTabs)');
      return tabView(doc, tabId);
    },
    batchUpdate: (docId, requests, rev) =>
      client.batchUpdate(docId, requests.map((r) => withTabId(r, tabId) as GDocRequest), rev),
  };
}

async function readTabs(
  client: DocsClient,
  docId: string,
): Promise<{ id: string; title: string }[]> {
  const doc = (await (
    client as DocsClient & { getDocumentWithTabs?: typeof client.getDocument }
  ).getDocumentWithTabs?.(docId)) as TabbedDoc | undefined;
  if (!doc) throw new Error('client does not support tab reads (getDocumentWithTabs)');
  return (doc.tabs ?? []).map((t) => ({
    id: t.tabProperties?.tabId ?? '',
    title: t.tabProperties?.title ?? '',
  }));
}

export interface TabsPushResult {
  steps: string[];
  perTab: Record<string, UpdatePlan>;
}

/**
 * Fetch every top-level tab as markdown (issue #22 — the gfetch half
 * of multi-tab round-tripping). Each tab goes through the same
 * meta + reader + serializer path as a single-doc fetch. The contract:
 * pushTabs of the fetched set is a per-tab noop.
 */
export async function fetchTabs(client: DocsClient, docId: string): Promise<TabInput[]> {
  const withTabs = (
    client as DocsClient & { getDocumentWithTabs?: typeof client.getDocument }
  ).getDocumentWithTabs;
  if (!withTabs) throw new Error('client does not support tab reads (getDocumentWithTabs)');
  const doc = (await withTabs.call(client, docId, 'PREVIEW_WITHOUT_SUGGESTIONS')) as TabbedDoc;
  const out: TabInput[] = [];
  for (const tab of doc.tabs ?? []) {
    const tabId = tab.tabProperties?.tabId;
    if (!tabId) continue;
    const view = tabView(doc, tabId);
    const meta = parseDocMeta(view);
    const body = serializeBlocks(docToBlocks(view, meta.consumedElements).map((r) => r.block));
    out.push({ title: tab.tabProperties?.title ?? '', markdown: emitFrontmatter(meta.meta) + body });
  }
  return out;
}

/** Top-level tab count — lets single-doc fetch refuse multi-tab docs. */
export async function countTabs(client: DocsClient, docId: string): Promise<number> {
  return (await readTabs(client, docId)).length;
}

/**
 * Reconcile + sync: plan against existing top-level tabs, execute
 * structural steps, then update each tab's content. Reorder happens
 * last, one move per batch (TAB-3).
 */
export async function pushTabs(
  client: DocsClient,
  docId: string,
  inputs: TabInput[],
  options?: SyncOptions,
): Promise<TabsPushResult> {
  const titles = inputs.map((t) => truncateTabTitle(t.title));
  let existing = await readTabs(client, docId);
  const plan = planTabs(titles, existing.map((t) => t.title));
  const steps: string[] = [];

  const createdTitles = new Set<string>();
  for (const step of plan) {
    if (step.op === 'update') continue;
    if (step.op === 'rename') {
      await client.batchUpdate(docId, [
        {
          updateDocumentTabProperties: {
            tabProperties: { tabId: existing[step.existingIndex]!.id, title: step.to },
            fields: 'title',
          },
        },
      ]);
      steps.push(`rename:${step.from}→${step.to}`);
    } else if (step.op === 'create') {
      await client.batchUpdate(docId, [{ addDocumentTab: { tabProperties: { title: step.title } } }]);
      createdTitles.add(step.title);
      steps.push(`create:${step.title}`);
    } else if (step.op === 'delete') {
      await client.batchUpdate(docId, [
        { deleteTab: { tabId: existing[step.existingIndex]!.id } },
      ]);
      steps.push(`delete:${step.title}`);
    }
  }

  // Re-read: creates/deletes changed ids and order.
  existing = await readTabs(client, docId);

  // New tabs default to paged; match the doc-creation default (issue
  // #54). Only tabs this push created — never flip pre-existing ones.
  if (options?.pageless !== false) {
    for (const tab of existing) {
      if (!createdTitles.has(tab.title)) continue;
      await client.batchUpdate(docId, [
        {
          updateDocumentStyle: {
            documentStyle: { documentFormat: { documentMode: 'PAGELESS' } },
            fields: 'documentFormat',
            tabId: tab.id,
          },
        },
      ]);
    }
  }

  // Reorder to exactly the input order — one batchUpdate per move.
  for (let target = 0; target < titles.length; target++) {
    const current = existing.findIndex((t) => t.title === titles[target]);
    if (current === -1 || current === target) continue;
    const [moved] = existing.splice(current, 1);
    existing.splice(target, 0, moved!);
    await client.batchUpdate(docId, [
      {
        updateDocumentTabProperties: {
          tabProperties: { tabId: moved!.id, index: target },
          fields: 'index',
        },
      },
    ]);
    steps.push(`move:${moved!.title}→${target}`);
  }

  // Content per tab, through the single-tab machinery.
  const perTab: Record<string, UpdatePlan> = {};
  for (const input of inputs) {
    const title = truncateTabTitle(input.title);
    const tab = existing.find((t) => t.title === title);
    if (!tab) throw new Error(`tab vanished after reconcile: ${title}`);
    perTab[title] = await updateFromMarkdown(tabClient(client, tab.id), docId, input.markdown, options);
  }
  return { steps, perTab };
}
