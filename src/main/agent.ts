import path from 'path';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import os from 'os';
import type {
  CommentThread,
  ProjectProposal,
  SetupMessage,
  SetupReply,
  Suggestion,
} from '@shared/types';
import { resolveQuote, makeAnchor } from '@shared/anchors';
import type { DocumentSession } from './session';
import { addProposal, loadProposals, validateProposalPath } from './proposalsStore';

/**
 * The Agent SDK ships ESM-only while our main bundle is CJS; a dynamic
 * import() survives the Rollup CJS transform as a real native import.
 */
type AgentSdk = typeof import('@anthropic-ai/claude-agent-sdk');
let sdkPromise: Promise<AgentSdk> | null = null;
function loadSdk(): Promise<AgentSdk> {
  sdkPromise ??= import('@anthropic-ai/claude-agent-sdk');
  return sdkPromise;
}

export interface ActiveTurn {
  done: Promise<string>;
  cancel: () => Promise<void>;
}

interface TurnCallbacks {
  onActivity: (detail: string) => void;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function buildReviewServer(sdk: AgentSdk, session: DocumentSession) {
  const { tool, createSdkMcpServer } = sdk;
  return createSdkMcpServer({
    name: 'review',
    version: '1.0.0',
    tools: [
      tool(
        'read_document',
        'Read the full current contents of the markdown document under review.',
        {},
        async () => ok(session.content),
      ),

      tool(
        'list_review_state',
        'List all comment threads and suggestions on the document, including resolved/rejected ones from earlier rounds. Rejected suggestions may carry a decisionComment explaining why the author declined them — read those before proposing similar changes.',
        {},
        async () =>
          ok(
            JSON.stringify(
              {
                round: session.review.round,
                comments: session.review.comments,
                suggestions: session.review.suggestions.map((s) => ({
                  ...s,
                  // The anchor offsets are internal bookkeeping; the quote is what matters.
                  anchor: { quote: s.anchor.quote, orphaned: s.anchor.orphaned },
                })),
              },
              null,
              2,
            ),
          ),
      ),

      tool(
        'reply_to_comment',
        'Reply to an existing comment thread. Use this to respond to the author\'s comments. Do not resolve threads — only the author resolves.',
        {
          comment_id: z.string().describe('The id of the comment thread to reply to'),
          text: z.string().describe('Your reply, in plain prose'),
        },
        async (args) => {
          const thread = session.review.comments.find((c) => c.id === args.comment_id);
          if (!thread) return ok(`Error: no comment thread with id ${args.comment_id}`);
          await session.mutateReview(() => {
            thread.replies.push({
              id: nanoid(8),
              author: 'agent',
              text: args.text,
              createdAt: new Date().toISOString(),
            });
          });
          return ok('Reply added.');
        },
      ),

      tool(
        'add_comment',
        'Open a new comment thread anchored to a passage of the document. Use for observations or questions that are not concrete text changes. The quote must be copied exactly from the document.',
        {
          quote: z.string().describe('Exact text from the document to anchor the comment to (keep it short — a phrase or sentence)'),
          text: z.string().describe('The comment body'),
        },
        async (args) => {
          const found = resolveQuote(session.content, args.quote);
          if (!found) {
            return ok(
              `Error: quote not found in document. Copy the text exactly, including punctuation and whitespace. Quote was: ${JSON.stringify(args.quote)}`,
            );
          }
          const thread: CommentThread = {
            id: nanoid(8),
            author: 'agent',
            createdAt: new Date().toISOString(),
            text: args.text,
            anchor: makeAnchor(session.content, found.from, found.to),
            replies: [],
            status: 'open',
          };
          await session.mutateReview((r) => r.comments.push(thread));
          return ok(`Comment added with id ${thread.id}.`);
        },
      ),

      tool(
        'update_notes',
        'Replace your persistent working notes for this project. Notes survive between rounds and travel with the repo, so record what future rounds need: decisions made and why, conventions the author prefers, open questions, project context that is not in any document. Keep them concise and structured; do not duplicate document text. This replaces the whole file — carry forward anything still relevant.',
        {
          content: z.string().describe('The full new contents of your notes file (markdown)'),
        },
        async (args) => {
          await session.setAgentNotes(args.content);
          return ok('Notes updated.');
        },
      ),

      tool(
        'propose_file',
        'Propose a new file for the workspace, with its full content. The file does NOT exist until the author explicitly accepts the proposal — it is staged for their review, like a suggestion. Only for new files (never existing paths), and only when a new file clearly serves the project or the author asked for one. Re-proposing the same path updates the pending proposal.',
        {
          path: z.string().describe('Where the file should live, relative to the workspace root (e.g. "docs/rollout-plan.md")'),
          content: z.string().describe('The complete initial contents of the file'),
          note: z.string().describe('One or two sentences on why this file should exist'),
        },
        async (args) => {
          const check = await validateProposalPath(session.workspaceRoot, args.path);
          if ('error' in check) return ok(`Error: ${check.error}`);
          const proposal = await addProposal(session.workspaceRoot, check.rel, args.content, args.note);
          return ok(`File proposal staged with id ${proposal.id} for ${proposal.path}. The author will see it in the explorer and decide.`);
        },
      ),

      tool(
        'suggest_edit',
        'Propose a concrete text change the author can accept or reject. The quote must be copied exactly from the document; the replacement is the full text that should take its place (empty string to delete). Keep each suggestion focused on one change — prefer several small suggestions over one sweeping rewrite.',
        {
          quote: z.string().describe('Exact text from the document to replace'),
          replacement: z.string().describe('The new text (empty string deletes the quoted text)'),
          note: z.string().describe('One or two sentences explaining why'),
        },
        async (args) => {
          if (args.quote === args.replacement) {
            return ok('Error: replacement is identical to the quote.');
          }
          const found = resolveQuote(session.content, args.quote);
          if (!found) {
            return ok(
              `Error: quote not found in document. Copy the text exactly, including punctuation and whitespace. Quote was: ${JSON.stringify(args.quote)}`,
            );
          }
          const suggestion: Suggestion = {
            id: nanoid(8),
            author: 'agent',
            createdAt: new Date().toISOString(),
            anchor: makeAnchor(session.content, found.from, found.to),
            replacement: args.replacement,
            note: args.note,
            status: 'pending',
          };
          await session.mutateReview((r) => r.suggestions.push(suggestion));
          return ok(`Suggestion added with id ${suggestion.id}.`);
        },
      ),
    ],
  });
}

const SYSTEM_PROMPT = `You are a writing collaborator reviewing a markdown document inside a review app called Margin. You work in review rounds, like a pull-request review: the author edits, comments, and submits; you review and respond; the author decides what to take.

The author also keeps a project-level discussion with you — framing for why
these documents exist, audience, goals, and general feedback that isn't tied
to a text range. It spans every document in the workspace; the author may
reference files as @path (relative to the workspace root) — read them with
the Read tool when they do. If the author writes /name (e.g. "/deslop this
before the next round"), that names a skill — invoke the skill with that
name and apply it as instructed. The discussion so far (with this round's new
messages marked) is included in your task prompt. **Your final message is
posted to that discussion as your reply** — answer new discussion messages
there, and keep it in the author's register.

You keep persistent working notes (shown in your task prompt when they
exist). They are your memory between rounds: update them via update_notes
when you learn something durable — a decision and its reasoning, a
convention the author prefers, project context that lives in no document.

How to work:
1. Read the document with read_document, and the existing threads/suggestions with list_review_state. Consult your working notes.
2. Address every open comment thread: reply with reply_to_comment. If a comment asks for a change, also propose it concretely with suggest_edit.
3. Treat inline "(TK: ...)" markers in the document text as author notes written outside this app — respond to them (add_comment anchored to the marker), and when you can, propose a suggest_edit replacing the marker with real text. In-app comments are the primary channel; TK markers are a fallback.
4. Propose your own improvements as suggestions (suggest_edit) and observations as comments (add_comment).

You may propose new files with propose_file (path + complete content). The
file exists only if the author accepts it, so a proposal is a question, not
an act — use it when a document should be split, when the author asks for a
new file, or when the project clearly needs one. Never propose files for
paths that already exist, and don't scatter files the author didn't ask
about. If a proposal was rejected (see its decisionComment in your task
prompt), don't re-propose it unless asked.

Ground rules:
- Never edit files directly. All changes go through suggest_edit so the author can accept or reject each one.
- Never resolve comment threads; only the author resolves.
- Respect earlier decisions: if a suggestion was rejected (see decisionComment), don't re-propose it unless the author asked you to revisit it.
- The author may file their own pending suggestions. If you have a substantive opinion on one (support, concern, a better alternative), say so via add_comment anchored to the same text; otherwise leave it alone.
- Prefer several small, focused suggestions over one large rewrite. Quote the smallest span that needs to change.
- Match the author's voice and register. Don't pad, don't add throat-clearing, don't inflate stakes.
- If the document is in good shape and you have nothing meaningful to add, say so in your final message rather than inventing busywork.
- You may read other files in the document's directory (e.g. reference/ material) for context.

Before finishing, update your working notes if this round produced anything
durable. Then finish with a message for the discussion thread: respond
to the author's new discussion messages (if any) and briefly summarize what
you reviewed and changed.`;

/** Render the project discussion for the turn prompt, marking new messages. */
function renderDiscussion(session: DocumentSession): string {
  const messages = session.discussion.messages.filter((m) => !m.pending).slice(-30);
  if (messages.length === 0) return '';
  const lines = messages.map((m) => {
    const who = m.author === 'user' ? 'Author' : 'You';
    const isNew = session.lastSubmittedMessageIds.has(m.id);
    return `${who}${isNew ? ' (new this round)' : ' (earlier)'}: ${m.text}`;
  });
  return `Project discussion so far (spans all documents in this workspace):\n${lines.join('\n\n')}`;
}

/**
 * Scripted review turn for dev/demo (`MARGIN_FAKE_AGENT=1`). Exercises the
 * same mutation, streaming, and checkpoint paths as a real round with no
 * credentials or token spend.
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

export async function runReviewTurn(
  session: DocumentSession,
  callbacks: TurnCallbacks,
  model?: string,
): Promise<ActiveTurn> {
  if (process.env.MARGIN_FAKE_AGENT) {
    return runFakeReviewTurn(session, callbacks);
  }
  const sdk = await loadSdk();
  const server = buildReviewServer(sdk, session);
  const dir = session.workspaceRoot;
  const relPath = path.relative(session.workspaceRoot, session.filePath);

  const promptParts = [
    `Review round ${session.review.round} for "${relPath}" (your working directory is the workspace root).`,
    'The author has submitted this document for review. Read it, address open comments, and make your suggestions.',
  ];
  const discussion = renderDiscussion(session);
  if (discussion) promptParts.push(discussion);
  const notes = await session.readAgentNotes();
  if (notes.trim()) {
    promptParts.push(`Your working notes from earlier rounds:\n${notes.trim()}`);
  }
  const { proposals } = await loadProposals(session.workspaceRoot);
  const undecided = proposals.filter((p) => p.status === 'pending');
  const rejected = proposals.filter((p) => p.status === 'rejected');
  if (undecided.length > 0 || rejected.length > 0) {
    const lines = [
      ...undecided.map((p) => `- ${p.path} (pending since ${p.createdAt}): ${p.note}`),
      ...rejected.map(
        (p) => `- ${p.path} (REJECTED${p.decisionComment ? `: "${p.decisionComment}"` : ''}): ${p.note}`,
      ),
    ];
    promptParts.push(`Your file proposals so far:\n${lines.join('\n')}`);
  }

  const q = sdk.query({
    prompt: promptParts.join('\n\n'),
    options: {
      cwd: dir,
      // undefined = the user's Claude Code default; accepts any model string
      // or alias ('opus', 'sonnet', 'haiku') the CLI accepts.
      model,
      systemPrompt: SYSTEM_PROMPT,
      mcpServers: { review: server },
      allowedTools: [
        'Read',
        'Grep',
        'Glob',
        'mcp__review__read_document',
        'mcp__review__list_review_state',
        'mcp__review__reply_to_comment',
        'mcp__review__add_comment',
        'mcp__review__suggest_edit',
        'mcp__review__update_notes',
        'mcp__review__propose_file',
      ],
      disallowedTools: ['Write', 'Edit', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch', 'Task'],
      permissionMode: 'dontAsk',
      // 'project' lets a writing project ship its own skills + CLAUDE.md
      // (<workspace>/.claude/skills, ./CLAUDE.md) without pulling in the
      // user's global config. User-level skills need 'user' here — see
      // DECISIONS.md §28.
      settingSources: ['project'],
      maxTurns: 80,
      // Electron's process.execPath is Electron itself, not Node; make the SDK
      // spawn its CLI with the system Node instead.
      executable: 'node',
      env: cleanEnv(),
      stderr: (data: string) => {
        console.error('[agent stderr]', data);
      },
    },
  });

  const done = (async () => {
    let summary = 'Review complete.';
    for await (const message of q) {
      if (message.type === 'assistant') {
        for (const block of message.message.content) {
          if (block.type === 'tool_use') {
            callbacks.onActivity(describeToolUse(block.name, block.input));
          } else if (block.type === 'text' && block.text.trim()) {
            callbacks.onActivity(truncate(block.text.trim(), 140));
          }
        }
      } else if (message.type === 'result') {
        if (message.subtype === 'success') {
          // Auth failures arrive as a "successful" result carrying the error
          // text (e.g. "Invalid API key · Please run /login").
          if (message.is_error) throw new Error(message.result || 'Agent turn failed');
          summary = message.result || summary;
        } else {
          throw new Error(`Agent turn failed (${message.subtype})`);
        }
      }
    }
    return summary;
  })();

  return {
    done,
    cancel: async () => {
      try {
        await q.interrupt();
      } catch {
        /* already finished */
      }
    },
  };
}

const SETUP_SYSTEM_PROMPT = `You are helping an author start a new writing project in Margin, a markdown review app. This is a short setup conversation on the welcome screen: understand what they want to write, then propose a project.

How to work:
- If the goal is clear enough from their message, propose immediately. Ask at most one short clarifying question, and only when you genuinely cannot pick a sensible structure without it.
- When ready, call propose_project exactly once: a kebab-case folderName, a human title, a one-line description, and 1-3 seed files. The main draft is a markdown file named after the piece (not "draft.md" — give it a real name) containing a skeletal outline in the author's likely register: real section headings, one-line notes of intent, no filler prose. Add a second file only when it clearly earns its place (e.g. notes.md for research-heavy work).
- Nothing is created until the author confirms the proposal card, so propose confidently — they can ask for changes.
- Your final text each turn is shown as your chat reply. Keep it to a sentence or two, conversational, no headings or lists. After proposing, briefly say what you set up and invite adjustments.`;

/**
 * One turn of the welcome-screen "start a new project" conversation. Fresh
 * session per message (like review rounds); the transcript rides in the
 * prompt. The propose_project tool only captures the card — the app
 * materializes it after the author confirms.
 */
export async function runSetupTurn(transcript: SetupMessage[]): Promise<SetupReply> {
  if (process.env.MARGIN_FAKE_AGENT) {
    return runFakeSetupTurn(transcript);
  }
  const sdk = await loadSdk();
  let proposal: ProjectProposal | undefined;
  const server = sdk.createSdkMcpServer({
    name: 'setup',
    version: '1.0.0',
    tools: [
      sdk.tool(
        'propose_project',
        'Propose the project: folder name, title, description, and seed files. Shown to the author as a card; created only when they confirm.',
        {
          folderName: z.string().describe('kebab-case folder name for the project directory'),
          title: z.string().describe('Human-readable project title'),
          description: z.string().describe('One line on what this project is'),
          files: z
            .array(
              z.object({
                path: z.string().describe('File path relative to the project folder'),
                content: z.string().describe('Complete initial contents'),
              }),
            )
            .min(1)
            .max(3),
        },
        async (args) => {
          proposal = args;
          return ok('Proposal captured — it is now showing to the author as a card.');
        },
      ),
    ],
  });

  const lines = transcript.map(
    (m, i) =>
      `${m.author === 'user' ? 'Author' : 'You'}${i === transcript.length - 1 ? ' (latest)' : ''}: ${m.text}`,
  );
  const q = sdk.query({
    prompt: `New-project conversation so far:\n\n${lines.join('\n\n')}`,
    options: {
      cwd: os.homedir(),
      systemPrompt: SETUP_SYSTEM_PROMPT,
      mcpServers: { setup: server },
      allowedTools: ['mcp__setup__propose_project'],
      disallowedTools: ['Write', 'Edit', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch', 'Task', 'Read', 'Grep', 'Glob'],
      permissionMode: 'dontAsk',
      settingSources: [],
      maxTurns: 6,
      executable: 'node',
      env: cleanEnv(),
    },
  });

  let reply = '';
  for await (const message of q) {
    if (message.type === 'result') {
      if (message.subtype === 'success') {
        if (message.is_error) throw new Error(message.result || 'Setup turn failed');
        reply = message.result || reply;
      } else {
        throw new Error(`Setup turn failed (${message.subtype})`);
      }
    }
  }
  return { reply, proposal };
}

/** Scripted setup turn for MARGIN_FAKE_AGENT — proposes on the first message. */
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

/**
 * Strip Claude-Code-session markers from the child environment. If Margin is
 * launched from inside a Claude Code session (e.g. `npm run dev` in an agent
 * terminal), the spawned CLI would otherwise detect a nested session and
 * refuse to use the stored credentials.
 */
function cleanEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_') || key.startsWith('CLAUDE_AGENT_')) {
      delete env[key];
    }
  }
  return env;
}

function describeToolUse(name: string, input: unknown): string {
  const args = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case 'mcp__review__read_document':
      return 'Reading the document…';
    case 'mcp__review__list_review_state':
      return 'Reading comments and suggestions…';
    case 'mcp__review__reply_to_comment':
      return 'Replying to a comment…';
    case 'mcp__review__add_comment':
      return `Adding a comment: ${truncate(String(args.text ?? ''), 80)}`;
    case 'mcp__review__suggest_edit':
      return `Suggesting an edit: ${truncate(String(args.note ?? ''), 80)}`;
    case 'mcp__review__propose_file':
      return `Proposing a new file: ${truncate(String(args.path ?? ''), 80)}`;
    case 'mcp__review__update_notes':
      return 'Updating working notes…';
    case 'Read':
      return `Reading ${path.basename(String(args.file_path ?? ''))}…`;
    case 'Grep':
    case 'Glob':
      return 'Searching reference material…';
    default:
      return `Using ${name}…`;
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
