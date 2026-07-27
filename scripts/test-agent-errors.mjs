#!/usr/bin/env node
/**
 * What a failed round says, and what it means (#79, #106).
 *
 * Two decisions live here. **The message names a next step** — the SDK's
 * own text is written for a stack trace, and "OAuth session expired and
 * could not be refreshed" tells an author nothing about the one action
 * that fixes it. And **network is checked before authentication**, since
 * losing the connection mid-refresh produces an error mentioning both,
 * and only one of those two causes is something the author can see.
 *
 *   node scripts/test-agent-errors.mjs
 */
import { load, reporter } from './lib/compile.mjs';

const { mod } = await load('src/shared/agentErrors.ts');
const { classifyAgentError, reviewOutputSize } = mod;
const { t, head, done } = reporter();

const kind = (raw) => classifyAgentError(raw).kind;

head('the failure that started this (#79)');
// Verbatim from the issue.
const oauth = 'Failed to authenticate: OAuth session expired and could not be refreshed';
t('is recognised as an auth problem', kind(oauth), 'auth');
t('and says how to fix it', /claude \/login/.test(classifyAgentError(oauth).message), true);
t('and is worth retrying afterwards', classifyAgentError(oauth).retryable, true);

head('losing the network (#106)');
for (const raw of [
  'request to https://api.anthropic.com failed, reason: getaddrinfo ENOTFOUND api.anthropic.com',
  'connect ECONNREFUSED 127.0.0.1:443',
  'read ECONNRESET',
  'fetch failed',
  'socket hang up',
]) {
  t(raw.slice(0, 46), kind(raw), 'network');
}
t('the message points at the connection',
  /connection/i.test(classifyAgentError('fetch failed').message), true);

head('network wins over auth when both are named');
// A token refresh that fails because the connection dropped mentions
// both. Sending someone to re-run /login over dead Wi-Fi is the worse
// mistake, and the connection is the cause they can actually observe.
t('dropped connection during a token refresh',
  kind('Failed to authenticate: getaddrinfo EAI_AGAIN api.anthropic.com'), 'network');

head('cancelling is not a failure');
t('cancelled', kind('The operation was aborted'), 'cancelled');
t('says so plainly', classifyAgentError('AbortError').message, 'Round cancelled.');

head('anything else keeps its own words');
// Inventing a friendly sentence for an error nobody has classified hides
// the only information there is.
t('unknown kind', kind('Tool call limit exceeded'), 'unknown');
t('message passes through', classifyAgentError('Tool call limit exceeded').message, 'Tool call limit exceeded');
t('empty error still says something',
  classifyAgentError('').message, 'The round failed for an unknown reason.');

head('did the round produce anything?');
// The question a rollback turns on: a round that added nothing did not
// happen, and is put back so it can simply be sent again.
const review = (comments, suggestions = 0) => ({
  comments: comments.map((replies) => ({ replies: Array(replies).fill(0) })),
  suggestions: Array(suggestions).fill(0),
});
t('an empty review', reviewOutputSize(review([])), 0);
t('the author’s own drafts count as present', reviewOutputSize(review([0, 0])), 2);
t('a reply lands', reviewOutputSize(review([1, 0])), 3);
t('a suggestion lands', reviewOutputSize(review([0, 0], 1)), 3);
t('unchanged review, unchanged size',
  reviewOutputSize(review([1, 0])) === reviewOutputSize(review([1, 0])), true);

done('agent-error');
