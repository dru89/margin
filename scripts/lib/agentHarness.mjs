/**
 * Shared setup for the two tiers that exercise the *real* Claude agent —
 * the contract tier (no credentials, runs in CI) and the live tier
 * (real credentials, run by hand).
 *
 * Everything else in the suite runs the scripted agent, so these are the
 * only places Margin's own SDK-facing code is executed at all.
 */
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

/**
 * Compile the Claude agent for direct import.
 *
 * Two things differ from `lib/compile.mjs`, both required:
 *
 * - The SDK stays **external**. Bundling it inlines the loader that finds
 *   the vendored CLI binary, which then looks beside the bundle instead of
 *   inside the package and fails with "Native CLI binary not found".
 * - The output lands **inside the repo** (`.tmp/`, gitignored), so that
 *   external import resolves through the real `node_modules`.
 */
export async function loadClaudeAgent() {
  const outDir = path.join(ROOT, '.tmp');
  mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, 'claude-agent.mjs');
  execFileSync(
    'npx',
    [
      'esbuild', 'src/main/agents/claude.ts',
      '--bundle', '--format=esm', '--platform=node',
      '--external:@anthropic-ai/claude-agent-sdk',
      '--alias:@shared=./src/shared',
      `--outfile=${out}`, '--log-level=error',
    ],
    { stdio: 'inherit', cwd: ROOT },
  );
  return import(`${pathToFileURL(out).href}?t=${Date.now()}`);
}

/**
 * The smallest thing `runReviewTurn` will accept as a session.
 *
 * A real `DocumentSession` owns a window and file watchers; the turn only
 * reads a handful of fields and calls back through three methods. Anything
 * the agent writes is recorded here rather than persisted, so a turn can
 * be run against a scratch directory and inspected afterwards.
 */
export function stubSession(dir, { content, round = 1 } = {}) {
  mkdirSync(path.join(dir, '.margin'), { recursive: true });
  const filePath = path.join(dir, 'doc.md');
  const text = content ?? '# Doc\n\nThe rollout window is unclear and the owner is unnamed.\n';
  writeFileSync(filePath, text);
  const review = { version: 1, document: 'doc.md', round, comments: [], suggestions: [], discussion: [] };
  return {
    filePath,
    workspaceRoot: dir,
    content: text,
    review,
    discussion: { version: 1, messages: [] },
    lastSubmittedMessageIds: new Set(),
    notes: '',
    async readAgentNotes() {
      return this.notes;
    },
    async setAgentNotes(next) {
      this.notes = next;
    },
    async mutateReview(fn) {
      fn(review);
    },
  };
}

/**
 * An environment with every trace of a signed-in Claude removed.
 *
 * `HOME` is a fresh directory and nothing is inherited but `PATH`. Both
 * halves matter: the credentials live under `HOME`, and a Claude Code
 * session exports `CLAUDE_CODE_*` variables that authenticate a child
 * process on their own — which is what `cleanEnv()` strips in the app,
 * and what made two hand-run probes of this pass for the wrong reason
 * before the harness existed.
 */
export function scrubbedEnv() {
  // Creates `.tmp` itself: this runs in the parent, before the child that
  // compiles the agent, so nothing else has made it on a fresh checkout.
  mkdirSync(path.join(ROOT, '.tmp'), { recursive: true });
  return { PATH: process.env.PATH, HOME: mkdtempSync(path.join(ROOT, '.tmp', 'home-')) };
}
