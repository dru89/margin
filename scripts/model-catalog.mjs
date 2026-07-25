#!/usr/bin/env node
/**
 * Prints the model catalog the Claude Code CLI reports to the Agent SDK —
 * the same data Margin's picker uses (issue #93).
 *
 * Run it OUTSIDE a Claude Code session: a nested session authenticates as
 * that session's identity and can report a different catalog than your own
 * `/model` list. From the repo root:  node scripts/model-catalog.mjs
 */
const { query } = await import('@anthropic-ai/claude-agent-sdk');
const q = query({ prompt: 'noop', options: { maxTurns: 1 } });
try {
  for (const m of await q.supportedModels()) {
    console.log(
      `${m.displayName.padEnd(22)} ${String(m.resolvedModel ?? '').padEnd(28)} ${m.description ?? ''}`,
    );
    if (m.supportedEffortLevels) console.log(`  effort: ${m.supportedEffortLevels.join(', ')}`);
  }
} finally {
  try { await q.interrupt?.(); } catch { /* already done */ }
  process.exit(0);
}
