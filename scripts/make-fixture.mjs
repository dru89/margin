#!/usr/bin/env node
/**
 * Build a project with a realistic review already in it, so the review
 * surface can be explored with real data instead of an empty document.
 *
 *   npm run fixture              # into .fixtures/review-surface
 *   npm run fixture -- ~/scratch # somewhere else
 *
 * Every state in docs/specs/review-surface.md §2 is represented, and every
 * anchor is computed against the real text, so nothing is orphaned by
 * accident. Re-running resets the project.
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const build = mkdtempSync(path.join(tmpdir(), 'margin-fixture-'));
const anchorsMod = path.join(build, 'anchors.mjs');
execFileSync('npx', ['esbuild', 'src/shared/anchors.ts', '--format=esm', `--outfile=${anchorsMod}`, '--log-level=error'], { stdio: 'inherit' });
const { makeAnchor, resolveQuote } = await import(pathToFileURL(anchorsMod).href);

const target = path.resolve(process.argv[2] ?? '.fixtures/review-surface');
rmSync(target, { recursive: true, force: true });
mkdirSync(path.join(target, '.margin'), { recursive: true });
// `margin.json` declares, `.margin/` stores (workspace spec §2). Without
// the declaration the fixture would open in the pre-adoption state and
// hide the discussion it exists to show.
writeFileSync(
  path.join(target, 'margin.json'),
  `${JSON.stringify({ version: 1, name: '2026 Self-Evaluation' }, null, 2)}\n`,
);

const DOC = `# 2026 Self-Evaluation

## Technical Incident Manager program

Designed and launched the Technical Incident Manager program: proposal and training program, onboarding guide, a Teams channel, and a PagerDuty rotation with P1/P2 bot notifications wired in before the Super Bowl. Kickoff was Feb 5 with engineering leads across alliances, and it was well received internally.

The program moved from C+I, where the original proposal had stalled for two quarters. Getting it unstuck meant rewriting the framing for an audience that had already said no once.

## Platform work

Partnered with the platform team on blue/green deployments, reducing rollback time across three properties. Led the mesh networking review and the C+I roadmap review that followed from it.

| Initiative | Status | Quarter |
|---|---|---|
| TIM program | Shipped | Q1 |
| Blue/green | In flight | Q2 |
| Mesh review | Complete | Q2 |

## What I would do differently

Spent too long on the first draft of the proposal before showing it to anyone. The version that landed was the fourth, and the first three taught me things I could have learned in a week of conversations.`;

const doc = path.join(target, 'self-evaluation.md');
writeFileSync(doc, DOC);
writeFileSync(path.join(target, 'notes.md'), '# Scratch notes\n\nA second document, so the file explorer has something to show.\n');
// Not markdown, so @-references to it have somewhere non-Margin to go.
mkdirSync(path.join(target, 'data'), { recursive: true });
writeFileSync(
  path.join(target, 'data', 'rotations.csv'),
  'week,primary,secondary\n2026-01-12,alex,sam\n2026-01-19,sam,jordan\n',
);

/** Anchor on real text; fails loudly rather than silently orphaning. */
const at = (quote) => {
  const found = resolveQuote(DOC, quote);
  if (!found) throw new Error(`fixture quote not in document: ${JSON.stringify(quote)}`);
  return makeAnchor(DOC, found.from, found.to);
};
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 864e5).toISOString();

// `review.round` increments at the top of submitReview, so a completed
// turn's output carries the *current* round — the agent answering round 5
// stamps its replies 5, and the author's next drafts are 5 as well. A
// fixture with the agent one round behind models a state that cannot occur.
const ROUND = 5;

const comments = [
  {
    id: 'th-draft', author: 'user', round: ROUND, createdAt: iso(0),
    text: 'Numbers here? "reducing rollback time" is doing a lot of work without one.',
    anchor: at('reducing rollback time'), replies: [], status: 'open',
  },
  {
    id: 'th-await', author: 'user', round: 4, createdAt: iso(1),
    text: 'Is this the right framing for a staff-level review?',
    anchor: at('Led the mesh networking review'), replies: [], status: 'open',
  },
  {
    id: 'th-unread', author: 'user', round: 3, createdAt: iso(2),
    text: 'Can we prove the rotation shipped before February?',
    anchor: at('PagerDuty rotation'),
    replies: [{
      id: 'rp-1', author: 'agent', round: ROUND, createdAt: iso(1),
      // Every case a chip has to render: a markdown file (opens in
      // Margin), a file that isn't (opens in its default app), and one
      // that names nothing here (lost).
      text: 'Found the evidence in @data/rotations.csv — the rotation predates the Super Bowl by three weeks. I put the working through in @notes.md. The older export (@data/2025-rotations.csv) is gone.',
    }],
    status: 'open',
  },
  {
    id: 'th-read', author: 'user', round: 2, createdAt: iso(4),
    text: 'Does the kickoff date matter to this audience?',
    anchor: at('Kickoff was Feb 5'), seenRound: 3,
    replies: [{
      id: 'rp-2', author: 'agent', round: 3, createdAt: iso(3),
      text: 'It does — it is the only date that pins the program to a quarter. Keep it.',
    }],
    status: 'open',
  },
  {
    id: 'th-long', author: 'user', round: 1, createdAt: iso(8),
    text: 'This section buries the outcome. What actually changed?',
    anchor: at('Designed and launched the Technical Incident Manager program'),
    replies: [
      { id: 'rp-l1', author: 'agent', round: 1, createdAt: iso(8), text: 'Suggest leading with the outcome and moving the artefact list after it.' },
      { id: 'rp-l2', author: 'user', round: 2, createdAt: iso(6), text: 'Tried that — it reads like bragging without the artefacts to back it.' },
      { id: 'rp-l3', author: 'agent', round: 2, createdAt: iso(6), text: 'Then keep the list but compress it to one clause.' },
      { id: 'rp-l4', author: 'user', round: 3, createdAt: iso(4), text: 'Closer. Can we get the P1 numbers in there?' },
      { id: 'rp-l5', author: 'agent', round: ROUND, createdAt: iso(1), text: 'Added them from the PagerDuty export — proposed as an edit.' },
    ],
    status: 'open',
  },
  {
    id: 'th-settled', author: 'user', round: 2, createdAt: iso(6), seenRound: 3,
    text: 'Is "alliances" the right word here, or is it internal jargon?',
    anchor: at('engineering leads across alliances'),
    replies: [{ id: 'rp-3', author: 'agent', round: 3, createdAt: iso(4), text: 'Jargon outside the org, but this is an internal document. Keep it.' }],
    status: 'resolved',
  },
  {
    id: 'th-orphan', author: 'user', round: 2, createdAt: iso(6),
    text: 'This needs a concrete outcome, not a description.',
    // Deliberately not in the document: the text was rewritten away.
    anchor: { from: 980, to: 1030, quote: 'a sentence that has since been rewritten', orphaned: true },
    replies: [], status: 'open',
  },
  {
    id: 'th-naming', author: 'user', round: 3, createdAt: iso(2), seenRound: 3,
    text: 'Use the full name on first mention and be consistent — "C+I" is wrong everywhere.',
    anchor: at('moved from C+I'),
    replies: [{
      id: 'rp-n1', author: 'agent', round: ROUND, createdAt: iso(1),
      text: 'Agreed. Proposed both occurrences as edits.',
    }],
    status: 'open',
  },
  {
    id: 'th-docs', author: 'user', round: 4, createdAt: iso(1),
    text: 'Should this mention the training numbers? — from the shared Doc',
    anchor: at('training program'), provenance: 'imported',
    driveCommentId: 'AAAA1111', collaborator: 'Priya Raman',
    replies: [{
      id: 'rp-4', author: 'user', round: 4, createdAt: iso(1),
      text: 'Sixty-two people through it by Q2.', collaborator: 'Priya Raman', driveReplyId: 'BBBB2222',
    }],
    status: 'open',
  },
];

const suggestions = [
  {
    id: 'sg-edit', author: 'agent', round: ROUND, createdAt: iso(1),
    anchor: at('moved from C+I, where'),
    replacement: 'moved from Commerce & Identity (C&I), where',
    note: 'Spell out on first use.', status: 'pending', inReplyTo: 'th-naming',
  },
  {
    id: 'sg-del', author: 'agent', round: ROUND, createdAt: iso(1),
    anchor: at(', and it was well received internally'),
    replacement: '', note: 'Unsupported claim — no evidence in the document.', status: 'pending',
  },
  {
    id: 'sg-edit2', author: 'agent', round: ROUND, createdAt: iso(1),
    anchor: at('the C+I roadmap review'),
    replacement: 'the C&I roadmap review',
    note: 'Same rename as above.', status: 'pending', inReplyTo: 'th-naming',
  },
  {
    id: 'sg-draft', author: 'user', round: ROUND, createdAt: iso(0),
    anchor: at('Spent too long on the first draft'),
    replacement: 'Spent three weeks on the first draft',
    note: 'Trying a more specific opening.', status: 'pending',
  },
  {
    // Deliberately large: spans several lines, to show what the inline
    // treatment does when a change is not a local edit.
    id: 'sg-big', author: 'agent', round: ROUND, createdAt: iso(1),
    // Anchored after sg-draft's range so the two do not overlap —
    // overlapping anchors are dropped, first one wins.
    anchor: at('The version that landed was the fourth, and the first three taught me things I could have learned in a week of conversations.'),
    replacement:
      'The version that shipped was the fourth. The three before it taught me things that a week of conversations would have taught me faster, and breaking that habit is the thing I most want to carry into next year.',
    note: 'A wholesale rewrite of the closing paragraph.', status: 'pending',
  },
  {
    id: 'sg-accepted', author: 'agent', round: 3, createdAt: iso(4),
    anchor: at('Getting it unstuck meant'), replacement: 'Getting it unstuck meant',
    note: 'Tightened the transition.', status: 'accepted', inReplyTo: 'th-long',
  },
  {
    id: 'sg-rejected', author: 'agent', round: 3, createdAt: iso(4),
    anchor: at('What I would do differently'), replacement: 'Lessons learned',
    note: 'Shorter heading.', status: 'rejected',
    decisionComment: 'Prefer the longer one — "lessons learned" is a cliché.',
  },
];

writeFileSync(`${doc}.review.json`, JSON.stringify({
  version: 1, document: 'self-evaluation.md', round: ROUND, comments, suggestions, discussion: [],
}, null, 2) + '\n');

writeFileSync(path.join(target, '.margin', 'discussion.json'), JSON.stringify({
  version: 1,
  messages: [
    { id: 'dm-1', author: 'user', createdAt: iso(8), text: 'This is my 2026 self-evaluation. Audience is my skip-level and the promo committee. Be blunt about anything that reads as vague.' },
    { id: 'dm-2', author: 'agent', createdAt: iso(8), text: 'Understood. I will flag claims without evidence, and anything that describes activity rather than outcome.' },
    { id: 'dm-3', author: 'user', createdAt: iso(0), text: 'Also check the C+I naming is consistent throughout.', pending: true },
  ],
}, null, 2) + '\n');

execFileSync('git', ['init', '-q'], { cwd: target });
execFileSync('git', ['add', '-A'], { cwd: target });
execFileSync('git', ['-c', 'user.email=fixture@margin', '-c', 'user.name=Fixture', 'commit', '-qm', 'Fixture project'], { cwd: target });

rmSync(build, { recursive: true, force: true });

const counts = { comments: comments.length, suggestions: suggestions.length };
console.log(`\nFixture project ready: ${target}`);
console.log(`  ${counts.comments} threads, ${counts.suggestions} suggestions, round ${ROUND} in progress`);
console.log(`  states: draft, awaiting, unread, read, settled, orphaned, a 6-message thread, one imported from Docs`);
console.log(`\n  npx electron . "${doc}"\n`);
