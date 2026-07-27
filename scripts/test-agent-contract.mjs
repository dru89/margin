#!/usr/bin/env node
/**
 * The contract tier: run Margin's *real* agent against the SDK with no
 * credentials at all.
 *
 * Everything else in the suite runs the scripted agent, so nothing else
 * executes `src/main/agents/claude.ts` — a renamed SDK export, a rejected
 * option, an invalid tool schema or a broken dynamic import would all
 * reach a user before a test. This tier closes that gap for free: an
 * unauthenticated turn costs **zero tokens and zero dollars** and returns
 * in about a third of a second, because the CLI answers "Not logged in"
 * without ever calling a model.
 *
 * Two things are asserted:
 *
 * 1. **The shape is accepted.** Getting as far as an auth (or network)
 *    refusal means the SDK loaded, our options were understood, and the
 *    MCP tools were built. Anything else means the call itself is wrong.
 * 2. **Not signed in is a failure, not a round.** The CLI reports it as a
 *    *successful* result carrying `is_error`, so a turn that only checked
 *    `subtype` would post "Please run /login" into the project discussion
 *    as though it were review feedback, and spend a round doing it.
 *
 *   node scripts/test-agent-contract.mjs
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { loadClaudeAgent, stubSession, scrubbedEnv } from './lib/agentHarness.mjs';
import { reporter } from './lib/compile.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const TIMEOUT_MS = 60_000;

/** Fail loudly rather than hanging a CI job. */
const withTimeout = (promise, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} did not settle in ${TIMEOUT_MS}ms`)), TIMEOUT_MS),
    ),
  ]);

/** Run a turn and report how it ended, never throwing. */
async function outcome(run) {
  try {
    await withTimeout(run(), 'turn');
    return { threw: false, message: '' };
  } catch (err) {
    return { threw: true, message: err instanceof Error ? err.message : String(err) };
  }
}

// ── child: does the work, in whatever environment it was given ────────
if (process.env.MARGIN_CONTRACT_CHILD) {
  const { claudeAgent } = await loadClaudeAgent();
  const dir = mkdtempSync(path.join(ROOT, '.tmp', 'contract-'));
  const session = stubSession(dir);
  const review = await outcome(async () => {
    const turn = await claudeAgent.runReviewTurn(session, { onActivity: () => {} });
    await turn.done;
  });
  const setup = await outcome(() =>
    claudeAgent.runSetupTurn([{ author: 'user', text: 'A short proposal about rollout risk.' }]),
  );
  rmSync(dir, { recursive: true, force: true });
  process.stdout.write(`\n__CONTRACT__${JSON.stringify({ review, setup })}\n`);
  process.exit(0);
}

// ── parent: re-runs the above with every credential removed ───────────
const env = scrubbedEnv();
let raw;
try {
  raw = execFileSync(process.execPath, [import.meta.filename], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: TIMEOUT_MS * 3,
    env: { ...env, MARGIN_CONTRACT_CHILD: '1' },
  });
} finally {
  rmSync(env.HOME, { recursive: true, force: true });
}

const line = raw.split('\n').find((l) => l.startsWith('__CONTRACT__'));
if (!line) {
  console.error(raw);
  throw new Error('the contract child produced no result');
}
const { review, setup } = JSON.parse(line.slice('__CONTRACT__'.length));

const { mod } = await import('./lib/compile.mjs').then((m) =>
  m.load('src/shared/agentErrors.ts'),
);
const { classifyAgentError } = mod;
const { t, head, done } = reporter();

head('the real agent, with no credentials');
// Reaching an auth refusal proves the SDK loaded and every option and tool
// schema was accepted. A network kind is the same proof on an offline
// runner; anything else means the call itself is malformed.
const reached = (o) => (o.threw ? classifyAgentError(o.message).kind : 'no failure at all');
t('a review turn fails rather than passing', review.threw, true);
t('...at the auth boundary, so the call shape is good', ['auth', 'network'].includes(reached(review)), true);
t('a setup turn fails rather than passing', setup.threw, true);
t('...at the same boundary', ['auth', 'network'].includes(reached(setup)), true);

head('not signed in is a failure, not a round');
// The CLI reports this as a *successful* result carrying `is_error`, so a
// turn that only read `subtype` would treat "Please run /login" as the
// agent's review and spend a round on it.
t('the round does not quietly succeed', review.threw, true);
t('and the author is told how to fix it',
  review.threw ? /claude \/login/.test(classifyAgentError(review.message).message) : false, true);

done('agent-contract');
