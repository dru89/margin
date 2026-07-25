/**
 * The model catalog, read from the Agent SDK (issue #93/#86).
 *
 * The SDK vendors its own Claude Code binary and that binary decides
 * which models exist — see the CLAUDE.md gotcha. So this list is never
 * hardcoded, and picking up new models is a dependency bump, not a
 * code change.
 *
 * Cached for the process lifetime: the spawn costs a second or two and
 * the catalog cannot change while the app runs (the binary is fixed).
 */
import type { ModelChoice } from '@shared/types';
import { cleanEnv } from './agent';

let cached: Promise<ModelChoice[]> | null = null;

async function load(): Promise<ModelChoice[]> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const q = query({
    prompt: 'noop',
    options: { executable: 'node', env: cleanEnv(), maxTurns: 1 },
  });
  try {
    const models = await q.supportedModels();
    return models.map((m) => ({
      value: m.value,
      label: m.displayName,
      // `description` leads with the version ("Opus 5 · Best for …");
      // keep the whole string — the version is the part users want.
      description: m.description ?? '',
      resolvedModel: m.resolvedModel,
      effortLevels: m.supportedEffortLevels ?? [],
    }));
  } finally {
    try {
      await q.interrupt?.();
    } catch {
      /* the throwaway session may already be gone */
    }
  }
}

export async function listModels(): Promise<ModelChoice[]> {
  cached ??= load().catch((err) => {
    cached = null; // a failed probe must not poison the cache
    throw err;
  });
  return cached;
}
