#!/usr/bin/env node
/**
 * The live tier: one real review round, against a real model.
 *
 * **Not run in CI.** It needs credentials CI does not have and spends
 * real tokens. Run it by hand before a release, or after touching the
 * prompt, the tools, or anything in `src/main/agents/claude.ts`:
 *
 *   npm run test:live
 *
 * Skips rather than fails when unauthenticated, the same bargain the
 * gdocs-sync live tier makes (`describe.skipIf(!token)`) — there is no
 * separate probe, the round itself reports it.
 *
 * What only this tier can prove: that a real model, given Margin's real
 * prompt and real tools, actually *calls* them. The scripted agent
 * mutates the session directly and never produces an SDK message stream,
 * so tool dispatch, `describeToolUse` and the result parsing have no
 * other coverage.
 *
 * Uses the cheapest model on purpose. One round on a three-line document
 * is a fraction of a cent.
 */
import { mkdtempSync, rmSync } from 'fs';
import path from 'path';
import { loadClaudeAgent, stubSession } from './lib/agentHarness.mjs';
import { load, reporter } from './lib/compile.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const MODEL = process.env.MARGIN_LIVE_MODEL ?? 'haiku';

// A document with two obvious problems, so a review has something
// uncontroversial to say and the assertions below are not a coin flip.
const DOC = [
  '# Rollout plan',
  '',
  'We will ship the migration soon. The rollout window is unclear and the owner is unnamed.',
  '',
  'Rollback is possible.',
  '',
].join('\n');

const { claudeAgent } = await loadClaudeAgent();
const { mod } = await load('src/shared/agentErrors.ts');
const { classifyAgentError } = mod;

const dir = mkdtempSync(path.join(ROOT, '.tmp', 'live-'));
const session = stubSession(dir, { content: DOC });
const activity = [];

let summary = null;
let failure = null;
try {
  const turn = await claudeAgent.runReviewTurn(
    session,
    { onActivity: (d) => activity.push(d) },
    MODEL,
  );
  summary = await turn.done;
} catch (err) {
  failure = err instanceof Error ? err.message : String(err);
}
rmSync(dir, { recursive: true, force: true });

if (failure && classifyAgentError(failure).kind === 'auth') {
  // Print the cause, not just "skipped": expired credentials and never
  // having signed in need different fixes, and a skip that hides which
  // one is a skip nobody can act on. Note that running this from *inside*
  // a Claude Code session skips too — `cleanEnv()` strips that session's
  // token refresh on purpose (see the CLAUDE.md gotcha), so the spawned
  // CLI falls back to whatever is stored on disk.
  console.log('\nSKIP  live tier — no usable credentials.');
  console.log(`      cause: ${failure}`);
  console.log('      fix:   run `claude /login` in a plain terminal, then re-run.');
  process.exit(0);
}

const { t, head, done } = reporter();

head(`a real review round (model: ${MODEL})`);
t('the turn completed', failure ?? 'ok', 'ok');
t('and returned a closing message', typeof summary === 'string' && summary.trim().length > 0, true);
// The point of this tier: a real model reached Margin's MCP tools and they
// worked. Loose on purpose — *what* it says is judgement, not a test. If
// this ever flakes, relax it to "activity was reported" rather than
// tightening the document until the model behaves.
const produced = session.review.comments.length + session.review.suggestions.length;
t('the agent used the review tools', produced > 0, true);
t('and the activity log saw the turn happen', activity.length > 0, true);

console.log(`\n      ${produced} review item(s); ${activity.length} activity line(s)`);
console.log(`      closing message: ${JSON.stringify(String(summary).slice(0, 100))}`);

done('live-round');
