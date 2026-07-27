import type { ModelChoice, ModelPreference, SetupMessage, SetupReply } from '@shared/types';
import type { DocumentSession } from '../session';

/**
 * What Margin needs from an agent (#160).
 *
 * This is a **port**, not an abstraction layer. It states the four things
 * the app asks an agent to do, so the cost of ever answering "could we
 * use a different one?" is readable here instead of being rediscovered by
 * reading the SDK calls. It deliberately does not try to be
 * provider-neutral below this line: the Claude implementation speaks
 * Claude Code's dialect fluently, and a second implementation would speak
 * its own.
 *
 * The reason to have it now is not portability, which nobody has asked
 * for. It is that the scripted agent already *was* a second
 * implementation — an `if (process.env.MARGIN_FAKE_AGENT)` branch inside
 * the module that talks to the SDK, in three places by the end. Naming
 * the interface turns a disguise into a type.
 *
 * **What does not live behind this port**, and is worth knowing before
 * anyone plans a swap: project skills and `CLAUDE.md` loading, the
 * built-in `Read`/`Grep`/`Glob` the agent reads the project with, and
 * the tool denylist that is the whole of "the agent never writes the
 * real file tree". Those are Claude Code harness features, configured in
 * one line each today. See #160.
 */

/** A turn in flight: awaitable, and interruptible by the author. */
export interface ActiveTurn {
  /** Resolves with the agent's closing message, or rejects. */
  done: Promise<string>;
  cancel: () => Promise<void>;
}

export interface TurnCallbacks {
  onActivity: (detail: string) => void;
}

export interface ReviewAgent {
  /**
   * Run one review round against the open document.
   *
   * Resolves once the turn is *running* — the caller awaits `done` for
   * the outcome, so it can hold a cancel handle in the meantime.
   */
  runReviewTurn(
    session: DocumentSession,
    callbacks: TurnCallbacks,
    model?: string,
    effort?: string,
  ): Promise<ActiveTurn>;

  /** One turn of the new-project conversation on the welcome screen. */
  runSetupTurn(transcript: SetupMessage[], pref?: ModelPreference): Promise<SetupReply>;

  /**
   * Models this agent can be asked for, for the picker.
   *
   * An agent that offers no choice returns an empty list rather than
   * inventing one.
   */
  listModels(): Promise<ModelChoice[]>;
}
