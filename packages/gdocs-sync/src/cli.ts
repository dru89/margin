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
import { promises as fs, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { authStatus, authorize, getAccessToken, loadClient, DRIVE_FILE_SCOPE, DRIVE_SCOPE } from './auth.ts';
import { makeDocxStager } from './images.ts';
import { shareDocument, type ShareRole } from './share.ts';
import { commentsAsMarkdown, commentsSection, fetchComments } from './comments.ts';
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

/**
 * Explain a 403/404 on a doc the user asked for. Under the default
 * drive.file scope those statuses are ambiguous: the doc may be
 * missing, unshared, or perfectly readable in a browser but invisible
 * to this tool. Tailor the advice to what would actually fix it here:
 * a client config that already allows full drive just needs re-auth;
 * otherwise the user needs a broader client (org-distributed or
 * self-made) before re-auth can help.
 */
export function scopeHintLines(opts: {
  docId: string;
  status: number;
  tokenScopes: string[];
  clientScopes: string[];
  configDir: string;
  detail?: string;
}): string[] {
  const lines = [`cannot open document ${opts.docId} (HTTP ${opts.status})`];
  if (opts.detail) lines.push(opts.detail);
  if (opts.tokenScopes.includes(DRIVE_SCOPE)) return lines;
  lines.push(
    'This does not necessarily mean the doc is missing: the cached token',
    'has only the drive.file scope, which sees only documents this tool',
    'created or opened. If the doc opens in your browser, the scope is',
    'the problem.',
  );
  if (opts.clientScopes.includes(DRIVE_SCOPE)) {
    lines.push(
      'Your OAuth client config already allows full-drive access — run',
      '`gdocs auth` to re-authorize, then retry.',
    );
  } else {
    lines.push(
      'To read docs this tool did not create, you need an OAuth client that',
      'permits the full drive scope:',
      '  - if your org distributes a gdocs-sync client config, install it and',
      '    run `gdocs auth`;',
      `  - otherwise add "scopes": ["${DRIVE_SCOPE}"] to the client JSON in`,
      `    ${opts.configDir} and run \`gdocs auth\` (see README, one-time setup).`,
    );
  }
  lines.push('If the doc does not exist or is not shared with you, scopes will not help.');
  return lines;
}

async function explainOpenFailure(docId: string, err: unknown): Promise<never> {
  const status = (err as { status?: number }).status;
  if (status !== 403 && status !== 404) throw err;
  const auth = await authStatus();
  const clientScopes = await loadClient().then(
    (c) => c.scopes ?? [],
    () => [] as string[],
  );
  fail(
    scopeHintLines({
      docId,
      status,
      tokenScopes: auth.scopes,
      clientScopes,
      configDir: auth.configDir,
      detail: err instanceof Error ? err.message : undefined,
    }).join('\n'),
  );
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
const PUSH_VALUE_FLAGS = new Set(['--doc', '--share-role', '--share-domain']);
const SHARE_ROLES = new Set(['viewer', 'commenter', 'editor']);

export function parsePushArgs(args: string[]): {
  specs: string[];
  target: string | null;
  writeUrl: boolean;
  share: boolean;
  shareDomain?: string;
  shareRole?: ShareRole;
  searchable: boolean;
  pageless: boolean;
} {
  const writeUrl = args.includes('--write-url');
  const valueOf = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    if (i === -1) return undefined;
    const v = args[i + 1];
    if (!v || v.startsWith('--')) throw new Error(`${flag} requires a value`);
    return v;
  };
  const explicitDoc = valueOf('--doc');
  let target = explicitDoc ? docIdFromUrl(explicitDoc) : null;
  if (explicitDoc && !target) throw new Error(`not a Google Doc reference: ${explicitDoc}`);
  const shareRole = valueOf('--share-role');
  if (shareRole && !SHARE_ROLES.has(shareRole)) {
    throw new Error(`--share-role must be viewer | commenter | editor, got: ${shareRole}`);
  }
  const shareDomain = valueOf('--share-domain');

  const specs: string[] = [];
  for (const [i, a] of args.entries()) {
    if (a.startsWith('--')) continue;
    if (i > 0 && PUSH_VALUE_FLAGS.has(args[i - 1]!)) continue; // a flag's value
    const id = docIdFromUrl(a);
    if (id) {
      if (target) throw new Error('more than one doc target given');
      target = id;
    } else {
      specs.push(a);
    }
  }
  if (specs.length === 0) throw new Error('push needs at least one markdown file');
  return {
    specs,
    target,
    writeUrl,
    share: args.includes('--share') || shareDomain !== undefined,
    ...(shareDomain !== undefined ? { shareDomain } : {}),
    ...(shareRole !== undefined ? { shareRole: shareRole as ShareRole } : {}),
    searchable: !args.includes('--no-searchable'),
    pageless: !args.includes('--no-pageless'),
  };
}

/** Share the pushed doc to a domain; the default domain rides the client config. */
async function shareTarget(
  docId: string,
  parsed: { shareDomain?: string; shareRole?: ShareRole; searchable: boolean },
): Promise<void> {
  const domain =
    parsed.shareDomain ?? (await loadClient().then((c) => c.shareDomain, () => undefined));
  if (!domain) {
    fail(
      'no share domain: pass --share-domain <domain> or add "share-domain" to the client JSON',
    );
  }
  await shareDocument(async () => (await getAccessToken())!, docId, {
    domain,
    role: parsed.shareRole ?? 'commenter',
    searchable: parsed.searchable,
  });
  console.log(`shared: ${domain} (${parsed.shareRole ?? 'commenter'})`);
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
      const id = target;
      const plan = await updateFromMarkdown(c, id, input.markdown, { baseDir, imageStager }).catch(
        (err) => explainOpenFailure(id, err),
      );
      console.log(`updated: ${plan.regions} region(s), ${plan.requestsSent} request(s)`);
      if (parsed.share) await shareTarget(id, parsed);
      console.log(`https://docs.google.com/document/d/${target}/edit`);
    } else {
      const { documentId } = await createFromMarkdown(c, input.title, input.markdown, {
        baseDir,
        imageStager,
        pageless: parsed.pageless,
      });
      const url = `https://docs.google.com/document/d/${documentId}/edit`;
      console.log(`created: ${url}`);
      if (parsed.share) await shareTarget(documentId, parsed);
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
  const id = target;
  const result = await pushTabs(c, id, inputs, {
    baseDir: path.dirname(path.resolve(inputs[0]!.file)),
    imageStager: makeDocxStager(async () => (await getAccessToken())!),
  }).catch((err) => explainOpenFailure(id, err));
  if (parsed.share) await shareTarget(id, parsed);
  for (const step of result.steps) console.log(`  ${step}`);
  for (const [title, plan] of Object.entries(result.perTab)) {
    console.log(`  ${title}: ${plan.requestsSent === 0 ? 'unchanged' : `${plan.requestsSent} request(s)`}`);
  }
  console.log(`https://docs.google.com/document/d/${target}/edit`);
}

async function cmdFetch(args: string[]): Promise<void> {
  const withComments = !args.includes('--no-comments');
  const tabsFlag = args.indexOf('--tabs');
  const rest = args.filter((a, i) => i !== tabsFlag && a !== '--no-comments');
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
    const tabs = await fetchTabs(c, docId).catch((err) => explainOpenFailure(docId, err));
    for (const tab of tabs) {
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
  let markdown = await fetchAsMarkdown(c, docId, { preserveFrontmatterFrom: existing }).catch(
    (err) => explainOpenFailure(docId, err),
  );
  if (withComments) {
    // null = comments endpoint denied; degrade to no section (lesson 6).
    const records = await fetchComments(async () => (await getAccessToken())!, docId);
    if (records && records.length > 0) markdown += commentsSection(records);
  }
  if (out) {
    await fs.writeFile(out, markdown, 'utf8');
    console.log(`wrote ${out}`);
  } else {
    process.stdout.write(markdown);
  }
}

const USAGE = `gdocs — markdown ↔ Google Docs sync

usage:
  gdocs auth [--scope drive|drive.file]
  gdocs push <file.md|Title=file.md ...> [--doc <url>] [options]
  gdocs fetch <url|docId> [out.md] [--tabs] [--no-comments]
  gdocs comments <url|docId> [out.md] [--unresolved-only]

Run \`gdocs <command> --help\` for command-specific options.`;

const HELP: Record<string, string> = {
  auth: `gdocs auth [--scope drive|drive.file|<full-url>]

Authorize with Google (loopback + PKCE) and cache a token.

  --scope drive       full Drive access
          drive.file  only files this tool created or opened (default)
          <url>       an explicit scope URL

The default scope comes from the client JSON's "scopes" array, else
drive.file.`,

  push: `gdocs push <file.md|Title=file.md ...> [--doc <url|docId>] [options]

Create or update a Google Doc from markdown. One file creates or updates a
single doc; multiple "Title=file.md" specs push tabs into one doc.

Target resolution: --doc, else a bare url/docId argument, else the first
file's frontmatter \`url:\`.

  --doc <url|docId>     target doc (required for multi-tab push)
  --write-url          write the created doc's url into the file's frontmatter
  --share              share the doc (domain from the client config)
  --share-domain <d>   share to domain d (implies --share)
  --share-role <r>     viewer | commenter | editor (default: commenter)
  --no-searchable      don't make the shared doc searchable
  --no-pageless        create in paged mode instead of pageless`,

  fetch: `gdocs fetch <url|docId> [out.md] [options]

Fetch a Google Doc as markdown. Writes to out.md, or stdout if omitted.

  --tabs         one file per top-level tab (out is treated as a directory)
  --no-comments  omit the trailing comments section`,

  comments: `gdocs comments <url|docId> [out.md] [--unresolved-only]

Print a document's comments as markdown (to out.md, or stdout if omitted).

  --unresolved-only   only comments that aren't resolved`,
};

const isHelpFlag = (a: string): boolean => a === '--help' || a === '-h';

export async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;

  // Top-level help: `gdocs`, `gdocs --help`, `gdocs help [command]`.
  if (command === undefined || isHelpFlag(command) || command === 'help') {
    const topic = command === 'help' ? rest[0] : undefined;
    console.log(topic && HELP[topic] ? HELP[topic] : USAGE);
    return;
  }
  // Per-command help, intercepted before the command runs so that e.g.
  // `gdocs auth --help` prints help instead of attempting to authorize.
  if (HELP[command] && rest.some(isHelpFlag)) {
    console.log(HELP[command]);
    return;
  }

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
    case 'comments': {
      const unresolvedOnly = rest.includes('--unresolved-only');
      const positional = rest.filter((a) => !a.startsWith('--'));
      const [ref, out] = positional;
      if (!ref) fail('comments needs a Drive file URL or id');
      const id = /\/d\/([A-Za-z0-9_-]{10,})/.exec(ref)?.[1] ?? docIdFromUrl(ref);
      if (!id) fail(`not a Drive file reference: ${ref}`);
      if (!(await getAccessToken())) fail('not authenticated — run `gdocs auth` first');
      const records = await fetchComments(async () => (await getAccessToken())!, id, {
        unresolvedOnly,
      });
      if (records === null) fail('comments are unavailable for this file (permission denied)');
      const md = commentsAsMarkdown(records);
      if (out) {
        await fs.writeFile(out, md, 'utf8');
        console.log(`wrote ${out}`);
      } else {
        console.log(md);
      }
      return;
    }
    default:
      console.error(`gdocs: unknown command: ${command}\n\n${USAGE}`);
      process.exit(1);
  }
}

// process.argv[1] is the path used to invoke us; when installed as a
// global bin it's a symlink into node_modules, while import.meta.url is
// the resolved real path. Compare realpaths so the guard holds under npm's
// symlinked bin (issue #72) — direct `node src/cli.ts` runs still match.
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return import.meta.url === pathToFileURL(entry).href;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
