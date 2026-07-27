import { nanoid } from 'nanoid';
import type { ModelChoice, SetupMessage, SetupReply } from '@shared/types';
import { resolveQuote, makeAnchor } from '@shared/anchors';
import type { DocumentSession } from '../session';
import { addProposal, validateProposalPath } from '../proposalsStore';
import type { ActiveTurn, ReviewAgent, TurnCallbacks } from './port';

/**
 * A scripted agent, selected by `MARGIN_FAKE_AGENT` (#160).
 *
 * This was always a second implementation of the port; it just lived as
 * an `if` at the top of the module that talks to the SDK, in three places
 * by the end. As its own implementation it can be read on its own terms:
 * it exercises the same mutation, streaming, and checkpoint paths as a
 * real round, with no credentials and no token spend.
 *
 * `MARGIN_FAKE_AGENT=fail:<text>` fails every turn with that text, which
 * is the only way to drive the recovery path (§71) without expiring a
 * token or unplugging a network by hand.
 */

function runFakeReviewTurn(session: DocumentSession, callbacks: TurnCallbacks): ActiveTurn {
  let cancelled = false;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const done = (async () => {
    callbacks.onActivity('Reading the document… (fake agent)');
    await sleep(600);
    for (const thread of session.review.comments.filter((c) => c.status === 'open')) {
      if (cancelled) return 'Fake review cancelled.';
      callbacks.onActivity('Replying to a comment… (fake agent)');
      await session.mutateReview(() => {
        thread.replies.push({
          id: nanoid(8),
          author: 'agent',
          text: `(fake agent) Acknowledged: “${thread.text.slice(0, 60)}”. A real round would respond substantively here.`,
          createdAt: new Date().toISOString(),
          round: session.review.round,
        });
      });
      await sleep(400);
    }
    // Suggest an edit against the first reasonably long line.
    const line = session.content.split('\n').find((l) => !l.startsWith('#') && l.trim().length > 40);
    if (line && !cancelled) {
      callbacks.onActivity('Suggesting an edit… (fake agent)');
      const found = resolveQuote(session.content, line);
      if (found) {
        await session.mutateReview((r) =>
          r.suggestions.push({
            id: nanoid(8),
            author: 'agent',
            createdAt: new Date().toISOString(),
            round: session.review.round,
            anchor: makeAnchor(session.content, found.from, found.to),
            replacement: `${line} (revised by fake agent)`,
            note: 'Demonstration suggestion from MARGIN_FAKE_AGENT — accept or reject to exercise the flow.',
            status: 'pending',
          }),
        );
      }
      await sleep(400);
    }
    const prior = await session.readAgentNotes();
    await session.setAgentNotes(
      `${prior.trimEnd()}${prior ? '\n' : ''}- (fake agent) notes path exercised ${new Date().toISOString()}`,
    );
    if (!cancelled) {
      callbacks.onActivity('Proposing a new file… (fake agent)');
      const check = await validateProposalPath(session.workspaceRoot, 'notes/fake-proposal.md');
      if ('rel' in check) {
        await addProposal(
          session.workspaceRoot,
          check.rel,
          '# Fake proposal\n\nStaged by MARGIN_FAKE_AGENT to exercise the accept/reject flow.\n',
          'Demonstration proposal from the fake agent — accept to materialize it, reject to record the decision.',
        );
      }
    }
    return 'Fake review round complete (MARGIN_FAKE_AGENT=1) — no model was consulted.';
  })();
  return {
    done,
    cancel: async () => {
      cancelled = true;
    },
  };
}
function runFakeSetupTurn(transcript: SetupMessage[]): SetupReply {
  const first = transcript.find((m) => m.author === 'user')?.text ?? 'a demo project';
  return {
    reply:
      '(fake agent) Here is a starter project based on what you described — confirm the card to create it, or tell me what to change.',
    proposal: {
      folderName: 'fake-project',
      title: 'Fake Project',
      description: `Scripted proposal from MARGIN_FAKE_AGENT (asked for: ${first.slice(0, 60)})`,
      files: [
        {
          path: 'Fake Project.md',
          content: `# Fake Project\n\nSeeded by the fake agent to exercise the new-project flow.\n\n## Outline\n\n- Opening\n- Middle\n- End\n`,
        },
      ],
    },
  };
}
/** Whatever `MARGIN_FAKE_AGENT` was set to, or '' when the real agent is in use. */
const mode = (): string => process.env.MARGIN_FAKE_AGENT ?? '';

/** The text a scripted failure should reject with, or null to succeed. */
function scriptedFailure(): string | null {
  const fail = /^fail:(.*)$/s.exec(mode());
  return fail ? fail[1] || 'scripted failure' : null;
}

export const fakeAgent: ReviewAgent = {
  async runReviewTurn(session: DocumentSession, callbacks: TurnCallbacks): Promise<ActiveTurn> {
    const failure = scriptedFailure();
    if (failure) {
      return { done: Promise.reject(new Error(failure)), cancel: async () => {} };
    }
    return runFakeReviewTurn(session, callbacks);
  },

  async runSetupTurn(transcript: SetupMessage[]): Promise<SetupReply> {
    const failure = scriptedFailure();
    if (failure) throw new Error(failure);
    return runFakeSetupTurn(transcript);
  },

  // No catalog without the real CLI. Empty rather than invented: the
  // picker shows the app default and nothing misleading.
  async listModels(): Promise<ModelChoice[]> {
    return [];
  },
};
