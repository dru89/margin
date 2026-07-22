#!/usr/bin/env node
/**
 * The gpush/gfetch-replacement CLI — a thin wrapper over the library,
 * following the reference conventions (doc-tools conventions.md):
 *
 *   gdocs auth
 *   gdocs push <file.md> [url|docId]          # single doc
 *   gdocs push "Title=a.md" "Other=b.md" --doc <url|docId>   # tabs
 *   gdocs fetch <url|docId> [out.md]
 *
 * Push target resolution: explicit argument, else the file's
 * frontmatter `url:` (UMISC-5); with --write-url the frontmatter url
 * is set after a create (reference behavior — library never does this
 * itself). Tab specs are `Title=path.md` or bare paths (title from
 * `#` heading → frontmatter title → filename stem), argument order =
 * tab order.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { authorize, getAccessToken, DRIVE_FILE_SCOPE, DRIVE_SCOPE } from './auth.ts';
import { makeDocxStager } from './images.ts';
import { HttpDocsClient } from './gdoc.ts';
import { docIdFromUrl } from './util.ts';
import { splitFrontmatter, stripCommentsSection } from './markdown.ts';
import { mdToCanonicalWithMeta } from './meta.ts';
import { createFromMarkdown, fetchAsMarkdown, updateFromMarkdown } from './sync.ts';
import { pushTabs, type TabInput } from './tabsync.ts';

function fail(message: string): never {
  console.error(`gdocs: ${message}`);
  process.exit(1);
}

async function client(): Promise<HttpDocsClient> {
  const token = await getAccessToken();
  if (!token) fail('not authenticated — run `gdocs auth` first');
  return new HttpDocsClient(async () => (await getAccessToken())!);
}

function titleOf(markdown: string, filePath: string): string {
  const { meta } = mdToCanonicalWithMeta(markdown);
  return meta.title ?? path.basename(filePath).replace(/\.(md|markdown|mdx)$/i, '');
}

async function readSpec(spec: string): Promise<TabInput & { file: string }> {
  const eq = spec.indexOf('=');
  const [title, file] =
    eq > 0 && !spec.slice(0, eq).includes('/') ? [spec.slice(0, eq), spec.slice(eq + 1)] : [null, spec];
  const markdown = await fs.readFile(file, 'utf8');
  return { title: title ?? titleOf(markdown, file), markdown, file };
}

/**
 * Split push arguments into file/tab specs and the doc target, before
 * anything touches the filesystem. A non-flag argument that parses as
 * a doc URL or bare docId is the target (the documented
 * `push <file.md> [url|docId]` form); everything else is a spec.
 * Throws on usage errors.
 */
export function parsePushArgs(args: string[]): {
  specs: string[];
  target: string | null;
  writeUrl: boolean;
} {
  const writeUrl = args.includes('--write-url');
  const docFlag = args.indexOf('--doc');
  const explicitDoc = docFlag !== -1 ? args[docFlag + 1] : undefined;
  if (docFlag !== -1 && !explicitDoc) throw new Error('--doc requires a value');
  let target = explicitDoc ? docIdFromUrl(explicitDoc) : null;
  if (explicitDoc && !target) throw new Error(`not a Google Doc reference: ${explicitDoc}`);

  const specs: string[] = [];
  for (const [i, a] of args.entries()) {
    if (a.startsWith('--') || (docFlag !== -1 && i === docFlag + 1)) continue;
    const id = docIdFromUrl(a);
    if (id) {
      if (target) throw new Error('more than one doc target given');
      target = id;
    } else {
      specs.push(a);
    }
  }
  if (specs.length === 0) throw new Error('push needs at least one markdown file');
  return { specs, target, writeUrl };
}

async function cmdPush(args: string[]): Promise<void> {
  let parsed: ReturnType<typeof parsePushArgs>;
  try {
    parsed = parsePushArgs(args);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  const { specs, writeUrl } = parsed;
  let { target } = parsed;

  const inputs = await Promise.all(specs.map(readSpec));
  const c = await client();

  // Target fallback: the first file's frontmatter url.
  if (!target) {
    const fm = splitFrontmatter(stripCommentsSection(inputs[0]!.markdown)).meta;
    if (fm.url) target = docIdFromUrl(fm.url);
  }

  if (inputs.length === 1) {
    const input = inputs[0]!;
    const baseDir = path.dirname(path.resolve(input.file));
    const imageStager = makeDocxStager(async () => (await getAccessToken())!);
    if (target) {
      const plan = await updateFromMarkdown(c, target, input.markdown, { baseDir, imageStager });
      console.log(`updated: ${plan.regions} region(s), ${plan.requestsSent} request(s)`);
      console.log(`https://docs.google.com/document/d/${target}/edit`);
    } else {
      const { documentId } = await createFromMarkdown(c, input.title, input.markdown, { baseDir, imageStager });
      const url = `https://docs.google.com/document/d/${documentId}/edit`;
      console.log(`created: ${url}`);
      if (writeUrl) {
        const { meta, body } = splitFrontmatter(input.markdown);
        void meta;
        const m = /^---\n[\s\S]*?\n---\n/.exec(input.markdown);
        const updated = m
          ? input.markdown.replace(m[0], m[0].replace(/\n---\n$/, `\nurl: ${url}\n---\n`))
          : `---\nurl: ${url}\n---\n\n${body}`;
        await fs.writeFile(input.file, updated, 'utf8');
        console.log(`wrote url: into ${input.file}`);
      }
    }
    return;
  }

  if (!target) fail('multi-tab push needs --doc <url|docId>');
  const result = await pushTabs(c, target, inputs, {
    baseDir: path.dirname(path.resolve(inputs[0]!.file)),
    imageStager: makeDocxStager(async () => (await getAccessToken())!),
  });
  for (const step of result.steps) console.log(`  ${step}`);
  for (const [title, plan] of Object.entries(result.perTab)) {
    console.log(`  ${title}: ${plan.requestsSent === 0 ? 'unchanged' : `${plan.requestsSent} request(s)`}`);
  }
  console.log(`https://docs.google.com/document/d/${target}/edit`);
}

async function cmdFetch(args: string[]): Promise<void> {
  const tabsFlag = args.indexOf('--tabs');
  const rest = args.filter((_, i) => i !== tabsFlag);
  const [ref, out] = rest;
  if (!ref) fail('fetch needs a doc URL or id');
  const docId = docIdFromUrl(ref);
  if (!docId) fail(`not a Google Doc reference: ${ref}`);
  const c = await client();

  if (tabsFlag !== -1) {
    // One file per top-level tab; prints the push-back spec list.
    const { fetchTabs } = await import('./tabsync.ts');
    const dir = out ?? '.';
    await fs.mkdir(dir, { recursive: true });
    const specs: string[] = [];
    for (const tab of await fetchTabs(c, docId)) {
      const file = path.join(dir, `${tab.title.replace(/[^\w.-]+/g, '-').replace(/^-|-$/g, '') || 'tab'}.md`);
      await fs.writeFile(file, tab.markdown, 'utf8');
      console.log(`wrote ${file}`);
      specs.push(`"${tab.title}=${file}"`);
    }
    console.log(`\npush back with:\n  gdocs push ${specs.join(' ')} --doc ${docId}`);
    return;
  }

  // Fetch over an existing file preserves its unknown frontmatter keys.
  const existing = out ? await fs.readFile(out, 'utf8').catch(() => undefined) : undefined;
  const markdown = await fetchAsMarkdown(c, docId, { preserveFrontmatterFrom: existing });
  if (out) {
    await fs.writeFile(out, markdown, 'utf8');
    console.log(`wrote ${out}`);
  } else {
    process.stdout.write(markdown);
  }
}

export async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'auth': {
      // --scope drive|drive.file|<full url>; default = client JSON's
      // "scopes" array, else drive.file.
      const i = rest.indexOf('--scope');
      let scopes: string[] | undefined;
      if (i !== -1) {
        const name = rest[i + 1];
        if (!name) fail('--scope requires a value (drive | drive.file | full URL)');
        const named: Record<string, string> = { drive: DRIVE_SCOPE, 'drive.file': DRIVE_FILE_SCOPE };
        scopes = [named[name] ?? name];
      }
      await authorize(scopes);
      return;
    }
    case 'push':
      return cmdPush(rest);
    case 'fetch':
      return cmdFetch(rest);
    default:
      console.log('usage: gdocs auth [--scope drive|drive.file] | push <file.md|Title=file.md ...> [--doc <url>] [--write-url] | fetch <url> [out.md]');
      process.exit(command ? 1 : 0);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
