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
import { authorize, getAccessToken } from './auth.ts';
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

async function cmdPush(args: string[]): Promise<void> {
  const writeUrl = args.includes('--write-url');
  const docFlag = args.indexOf('--doc');
  const explicitDoc = docFlag !== -1 ? args[docFlag + 1] : undefined;
  const specs = args.filter((a, i) => !a.startsWith('--') && (docFlag === -1 || i !== docFlag + 1));
  if (specs.length === 0) fail('push needs at least one markdown file');

  const inputs = await Promise.all(specs.map(readSpec));
  const c = await client();

  // Target: --doc, else a bare trailing docId/url arg (single-file
  // form), else the first file's frontmatter url.
  let target = explicitDoc ? docIdFromUrl(explicitDoc) : null;
  if (!target && inputs.length === 2 && !inputs[1]!.file.endsWith('.md')) fail('use --doc for the target');
  if (!target) {
    const fm = splitFrontmatter(stripCommentsSection(inputs[0]!.markdown)).meta;
    if (fm.url) target = docIdFromUrl(fm.url);
  }

  if (inputs.length === 1) {
    const input = inputs[0]!;
    const baseDir = path.dirname(path.resolve(input.file));
    if (target) {
      const plan = await updateFromMarkdown(c, target, input.markdown, { baseDir });
      console.log(`updated: ${plan.regions} region(s), ${plan.requestsSent} request(s)`);
      console.log(`https://docs.google.com/document/d/${target}/edit`);
    } else {
      const { documentId } = await createFromMarkdown(c, input.title, input.markdown, { baseDir });
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

  const markdown = await fetchAsMarkdown(c, docId);
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
    case 'auth':
      await authorize();
      return;
    case 'push':
      return cmdPush(rest);
    case 'fetch':
      return cmdFetch(rest);
    default:
      console.log('usage: gdocs auth | push <file.md|Title=file.md ...> [--doc <url>] [--write-url] | fetch <url> [out.md]');
      process.exit(command ? 1 : 0);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
