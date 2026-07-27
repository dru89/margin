import type { ReviewAgent } from './port';
import { claudeAgent } from './claude';
import { fakeAgent } from './fake';

export type { ActiveTurn, ReviewAgent, TurnCallbacks } from './port';

/**
 * Which agent this process is using — the one place that decides (#160).
 *
 * Read at call time rather than at module load so a test can set the
 * variable after import, and so the choice is never baked into a bundle.
 */
export function getAgent(): ReviewAgent {
  return process.env.MARGIN_FAKE_AGENT ? fakeAgent : claudeAgent;
}
