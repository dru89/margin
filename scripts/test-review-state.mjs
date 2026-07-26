#!/usr/bin/env node
/**
 * Review-state tests. No framework — compile the pure module with esbuild
 * and assert against it (the pattern CLAUDE.md describes for logic that
 * doesn't need the app running).
 *
 *   node scripts/test-review-state.mjs
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const dir = mkdtempSync(path.join(tmpdir(), 'margin-state-'));
const out = path.join(dir, 'reviewState.mjs');
execFileSync('npx', ['esbuild', 'src/shared/reviewState.ts', '--format=esm', `--outfile=${out}`, '--log-level=error'], { stdio: 'inherit' });
const {
  threadState, suggestionState, isUnread, markSeen, countThreads, threadNeedsYou,
  suggestionNeedsYou, threadEditable, replyEditable, suggestionEditable,
  validateInReplyTo, linkedSuggestions, linkSummary,
} = await import(pathToFileURL(out).href);

let fails = 0;
const t = (label, got, want) => {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(56)} ${got}${ok ? '' : `   (want ${want})`}`);
};
const head = (s) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 60 - s.length))}`);

const thread = (o = {}) => ({
  id: 'x', author: 'user', createdAt: '', text: 'c', anchor: { from: 0, to: 1, quote: 'a' },
  replies: [], status: 'open', round: 0, ...o,
});
const reply = (o = {}) => ({ id: 'r', author: 'agent', text: 'r', createdAt: '', round: 0, ...o });
const sug = (o = {}) => ({ id: 's', author: 'agent', createdAt: '', round: 4, anchor: {}, replacement: 'x', status: 'pending', ...o });

head('the author’s own writing');
t('written this round, not yet sent', threadState(thread({ round: 3 }), 3), 'draft');
t('same comment once the round is submitted', threadState(thread({ round: 3 }), 4), 'awaiting');
t('a reply added this round', threadState(thread({ round: 1, replies: [reply({ author: 'user', round: 4 })] }), 4), 'draft');

head('the agent');
const answered = thread({ round: 3, replies: [reply({ round: 4 })] });
t('replied, never looked at', threadState(answered, 4), 'unread');
t('after looking', threadState(markSeen(answered), 4), 'read');
t('replied again in a later round', threadState({ ...markSeen(answered), replies: [reply({ round: 4 }), reply({ round: 5 })] }, 5), 'unread');
t('resolved beats everything', threadState({ ...answered, status: 'resolved' }, 4), 'settled');
t('agent output in the current round is not a draft', threadState(thread({ author: 'agent', round: 4 }), 4), 'unread');

head('Google Docs collaborators');
const imported = thread({ provenance: 'imported', round: 4, collaborator: 'Sam' });
t('an imported thread is external, not your draft', threadState(imported, 4), 'unread');
t('after looking', threadState(markSeen(imported), 4), 'read');
t('your own reply sent to the Doc stays yours',
  threadState(thread({ round: 1, provenance: 'imported', seenRound: 1, replies: [reply({ author: 'user', round: 4, driveReplyId: 'd1' })] }), 4), 'draft');
t('a collaborator’s reply is theirs',
  threadState(thread({ round: 1, provenance: 'imported', seenRound: 1, replies: [reply({ author: 'user', round: 4, driveReplyId: 'd1', collaborator: 'Sam' })] }), 4), 'unread');

head('seen tracking');
t('unread survives taking another turn', isUnread(answered), true);
t('markSeen is idempotent', markSeen(markSeen(answered)).seenRound, 4);
t('markSeen leaves your own thread alone', markSeen(thread({ round: 3 })).seenRound, undefined);

head('suggestions');
t('yours, this round', suggestionState(sug({ author: 'user', round: 4 }), 4), 'draft');
t('yours, already sent', suggestionState(sug({ author: 'user', round: 3 }), 4), 'pending');
t('the agent’s, awaiting you', suggestionState(sug(), 4), 'pending');
t('accepted', suggestionState(sug({ status: 'accepted' }), 4), 'decided');
t('rejected', suggestionState(sug({ status: 'rejected' }), 4), 'decided');

head('needs you — outstanding, not merely new');
// The point of this predicate over `unread`: reading is not responding, so
// looking at a thread must not remove it from the list being worked through.
{
  const answered2 = thread({ round: 3, replies: [reply({ round: 4 })] });
  t('the agent replied and you have not looked', threadNeedsYou(answered2, 4), true);
  t('...and still after you look', threadNeedsYou(markSeen(answered2), 4), true);
  t('until you reply', threadNeedsYou(markSeen({ ...answered2, replies: [reply({ round: 4 }), reply({ author: 'user', round: 4 })] }), 4), false);
  t('a thread you are waiting on does not need you', threadNeedsYou(thread({ round: 3 }), 4), false);
  t('your own unsent draft does not need you', threadNeedsYou(thread({ round: 4 }), 4), false);
  t('a resolved thread does not need you', threadNeedsYou({ ...answered2, status: 'resolved' }, 4), false);
  t('a collaborator waiting on you', threadNeedsYou(thread({ provenance: 'imported', round: 4 }), 4), true);
  t("the agent's undecided suggestion", suggestionNeedsYou(sug(), 4), true);
  t('once decided', suggestionNeedsYou(sug({ status: 'accepted' }), 4), false);
  t('your own draft suggestion', suggestionNeedsYou(sug({ author: 'user', round: 4 }), 4), false);
}

head('counts');
const counts = countThreads([thread({ round: 4 }), answered, { ...answered, status: 'resolved' }, thread({ round: 1 })], 4);
t('unread', counts.unread, 1);
t('draft', counts.draft, 1);
t('awaiting', counts.awaiting, 1);
t('settled', counts.settled, 1);

// ── transitions ────────────────────────────────────────────────────────
// States are points; these are the edges between them. This is where the
// bug lived: replying to an unread thread left it reading as unread, so
// the reply was invisible and the thread kept asking to be read.
function world() {
  let round = 0;
  let th = thread();
  return {
    comment()      { th = { ...th, round }; return this; },
    submit()       { round += 1; return this; },  // increments at the top of submitReview
    agentReplies() { th = { ...th, replies: [...th.replies, reply({ round })] }; return this; },
    youReply()     { th = markSeen({ ...th, replies: [...th.replies, reply({ author: 'user', round })] }); return this; },
    click()        { th = markSeen(th); return this; },
    resolve()      { th = { ...th, status: 'resolved' }; return this; },
    reopen()       { th = { ...th, status: 'open' }; return this; },
    state()        { return threadState(th, round); },
  };
}
const step = (w, label, want) => t(label, w.state(), want);

head('transition: the ordinary life of a thread');
const w = world();
step(w.comment(), 'you write a comment', 'draft');
step(w.submit(), 'you submit the round', 'awaiting');
step(w.agentReplies(), 'Claude answers', 'unread');
step(w.click(), 'you open it', 'read');
step(w.resolve(), 'you resolve it', 'settled');
step(w.reopen(), 'you reopen it', 'read');

head('transition: a second round on the same thread');
const w2 = world().comment().submit().agentReplies().click();
step(w2, 'read after round 1', 'read');
step(w2.submit(), 'you submit again without touching it', 'read');
step(w2.agentReplies(), 'Claude adds more', 'unread');

head('transition: replying is proof you read it');
const w3 = world().comment().submit().agentReplies();
step(w3, 'Claude answers, you have not looked', 'unread');
step(w3.youReply(), 'you reply without clicking first', 'draft');
step(w3.submit(), 'and send it', 'awaiting');

head('transition: resolve wins from any state');
step(world().comment().resolve(), 'resolve a draft', 'settled');
step(world().comment().submit().agentReplies().resolve(), 'resolve an unread', 'settled');

head('editable while it is still yours and unsent (spec §8, #89)');
t('your comment, this round', threadEditable(thread({ round: 4 }), 4), true);
t('the same comment once sent', threadEditable(thread({ round: 3 }), 4), false);
t('the agent’s', threadEditable(thread({ author: 'agent', round: 4 }), 4), false);
// author is 'user' on an imported thread and its round is the one it
// arrived in, so the naive test says "yours, this round" — it is neither.
t('a collaborator’s Doc comment is not yours to rewrite',
  threadEditable(thread({ round: 4, provenance: 'imported', collaborator: 'Sam', driveCommentId: 'd1' }), 4), false);
t('a resolved thread is history', threadEditable(thread({ round: 4, status: 'resolved' }), 4), false);
t('your reply, this round', replyEditable(reply({ author: 'user', round: 4 }), 4), true);
t('your reply, already sent', replyEditable(reply({ author: 'user', round: 3 }), 4), false);
// It exists on the Doc under your name; editing the local copy would
// silently disagree with the copy other people are reading.
t('your reply that went to the Doc',
  replyEditable(reply({ author: 'user', round: 4, driveReplyId: 'd1' }), 4), false);
t('the agent’s reply', replyEditable(reply({ round: 4 }), 4), false);
t('your suggestion, this round', suggestionEditable(sug({ author: 'user', round: 4 }), 4), true);
t('your suggestion, already sent', suggestionEditable(sug({ author: 'user', round: 3 }), 4), false);
t('the agent’s suggestion', suggestionEditable(sug({ round: 4 }), 4), false);
t('your suggestion, already decided',
  suggestionEditable(sug({ author: 'user', round: 4, status: 'accepted' }), 4), false);

head('linking an edit to the comment it answers (spec §7, #100)');
const threads = [thread({ id: 't1' }), thread({ id: 't2', status: 'resolved' })];
const link = (o) => sug({ author: 'agent', round: 4, ...o });
// The agent writes this id, so it is untrusted in the same sense a path is.
// The check is narrow on purpose: reject only what would be false.
t('no link at all is fine', 'error' in validateInReplyTo(threads, undefined), false);
t('an empty string is no link', JSON.stringify(validateInReplyTo(threads, '')), '{}');
t('a thread on this document', validateInReplyTo(threads, 't1').threadId, 't1');
t('an id naming nothing', 'error' in validateInReplyTo(threads, 'nope'), true);
// Unusual but true, and refusing it would throw away a correct edit over a
// judgement call that belongs to the author.
t('a resolved thread is still a real thread', validateInReplyTo(threads, 't2').threadId, 't2');

const linked = [
  link({ id: 's1', inReplyTo: 't1' }),
  link({ id: 's2', inReplyTo: 't1', status: 'accepted' }),
  link({ id: 's3', inReplyTo: 't1', status: 'rejected' }),
  link({ id: 's4', inReplyTo: 't2' }),
  link({ id: 's5' }),
];
t('one comment, many edits', linkedSuggestions(linked, 't1').map((s) => s.id).join(','), 's1,s2,s3');
t('an unlinked edit belongs to no thread', linkedSuggestions(linked, 'tX').length, 0);
// Pending and decided are split because they read differently: rows that
// are work, versus a record of what happened.
t('pending are the ones still asking', linkSummary(linked, 't1').pending.map((s) => s.id).join(','), 's1');
t('decided are counted, not listed',
  `${linkSummary(linked, 't1').accepted}/${linkSummary(linked, 't1').rejected}`, '1/1');

rmSync(dir, { recursive: true, force: true });
console.log(fails === 0 ? '\nAll review-state cases pass.' : `\n${fails} FAILING`);
process.exit(fails === 0 ? 0 : 1);
