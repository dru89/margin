import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { launch, doc, type Margin } from './margin';

/**
 * Journey 1: a review round, end to end (#134, from #131).
 *
 * Open a document → comment on a passage → submit → the agent replies and
 * proposes an edit → accept it → resolve the thread.
 *
 * This is the product. The other journeys each cover a slice; nothing
 * covered the round itself, which is the path every other feature hangs
 * off. Four seams get crossed here and each one has produced a bug:
 *
 * - **review-state ownership** passes from the renderer to the main
 *   process for the duration of the round and back afterwards. Getting
 *   this wrong means the renderer writes a stale review over the agent's
 *   work — silently, since both copies look plausible.
 * - **the agent tool surface** mutates the sidecar from main.
 * - **anchor remapping** has to survive an accepted edit that shifts every
 *   offset after it.
 * - **sidecar persistence** has to hold all of it across autosave.
 *
 * Assertions are on what the author ends up with: the file on disk, the
 * sidecar, and what the sidebar says out loud. Never markup.
 */

// The fake agent suggests an edit against the first non-heading line over
// 40 characters, so the *first* long line is where its edit lands and the
// second is a safe place to anchor a comment that must survive it.
const DOC = [
  '# Rollout plan',
  '',
  'The first paragraph is long enough to attract a suggested edit from the agent.',
  '',
  'The second paragraph mentions the staging window and is where the comment goes.',
  '',
].join('\n');

const QUOTE = 'the staging window';

/**
 * The sidecar, or null while it does not exist yet.
 *
 * Null rather than throwing because these are read inside `expect.poll`,
 * which retries a failed assertion but propagates a thrown error — so a
 * read that lands in the gap before the first autosave would end the test
 * with ENOENT instead of waiting the moment out.
 */
const sidecarOf = (file: string) => {
  try {
    return JSON.parse(readFileSync(`${file}.review.json`, 'utf8'));
  } catch {
    return null;
  }
};
const fileOf = (file: string) => readFileSync(file, 'utf8');

/**
 * Select `quote` by walking the caret from the start of the *document*.
 *
 * Deliberately not "click the line, then Home, then arrow along it".
 * Clicking a `.cm-line` lands at the centre of its box, which for a
 * wrapped line is the end of a visual row — and `Home` with line wrapping
 * on goes to the start of that *visual* row, not the logical line. The
 * offsets then count from somewhere unintended and the arrows walk off
 * the end of the document, leaving no selection at all and a disabled
 * `+ Comment` with nothing to say why. Counting from the document start
 * is exact: one ArrowRight per character, newlines included.
 */
async function selectQuote(m: Margin, source: string, quote: string) {
  const at = source.indexOf(quote);
  if (at < 0) throw new Error(`quote not in the document: ${quote}`);
  await m.first.locator('.cm-content').click();
  await m.first.keyboard.press('ControlOrMeta+Home');
  for (let i = 0; i < at; i++) await m.first.keyboard.press('ArrowRight');
  for (let i = 0; i < quote.length; i++) await m.first.keyboard.press('Shift+ArrowRight');
}

test.describe('journey 1: a review round', () => {
  let m: Margin;
  test.afterEach(async () => m?.close());

  test('comment, submit, accept the edit, resolve — and nothing loses its place', async () => {
    m = await launch();
    const file = doc(m.dir, 'p/plan.md', DOC);
    await m.first.evaluate((f) => window.margin.openPath(f), file);
    await expect.poll(() => m.first.evaluate(() => !!document.querySelector('.cm-content'))).toBe(true);

    // ── comment ──────────────────────────────────────────────────────
    await selectQuote(m, DOC, QUOTE);
    await m.first.getByRole('button', { name: /\+ comment/i }).click();
    await m.first.locator('.card-composer textarea').first().fill('Which window exactly?');
    await m.first.locator('.card-composer .card-actions')
      .getByRole('button', { name: 'Comment', exact: true }).click();

    await expect.poll(() => sidecarOf(file)?.comments?.length).toBe(1);
    const staged = sidecarOf(file).comments[0];
    expect(staged.anchor.quote).toBe(QUOTE);
    // Staged, not sent: round 0 is what makes it read as a draft.
    expect({ round: staged.round, reviewRound: sidecarOf(file).round }).toEqual({ round: 0, reviewRound: 0 });

    // ── submit ───────────────────────────────────────────────────────
    await m.first.getByRole('button', { name: /submit for review/i }).click();
    await m.first.getByRole('button', { name: /send round/i }).click();

    // The round counter moves at the top of the turn, which is what makes
    // "unsent" computable at all.
    await expect.poll(() => sidecarOf(file)?.round, { timeout: 60_000 }).toBe(1);

    // ── the agent answers ────────────────────────────────────────────
    await expect.poll(() => sidecarOf(file)?.comments?.[0]?.replies?.length, { timeout: 60_000 }).toBe(1);
    await expect.poll(() => sidecarOf(file)?.suggestions?.length, { timeout: 60_000 }).toBe(1);
    const answered = sidecarOf(file);
    expect(answered.comments[0].replies[0]).toMatchObject({ author: 'agent', round: 1 });
    expect(answered.suggestions[0]).toMatchObject({ author: 'agent', round: 1, status: 'pending' });

    // The renderer was told, not just the file: the reply is on screen and
    // the summary bar counts the two things now waiting on the author.
    await expect(m.first.locator('.card-comment')).toContainText('Acknowledged');
    await expect(m.first.locator('.review-counts')).toContainText('2 need you');

    // ── ownership comes back ─────────────────────────────────────────
    // Wait for the round to *finish*, not merely for its first results to
    // land. The agent keeps working after the suggestion — notes, then a
    // file proposal — and the document stays read-only for all of it,
    // which is the lock doing its job. Typing into the gap is a race an
    // author cannot lose but a test can: it silently does nothing.
    await expect(m.first.getByText(/round 1 returned/i)).toBeVisible({ timeout: 60_000 });

    // The renderer owns the review again and must have taken the agent's
    // version with it. Editing the document makes it the writer; if it
    // were holding the copy it had before the round, autosave would put
    // that back and the reply would vanish.
    await m.first.locator('.cm-line').first().click();
    await m.first.keyboard.press('End');
    await m.first.keyboard.type(' v2');
    await expect.poll(() => fileOf(file).includes('# Rollout plan v2')).toBe(true);
    expect(sidecarOf(file).comments[0].replies.length).toBe(1);

    // ── accept the edit ──────────────────────────────────────────────
    const before = sidecarOf(file).comments[0].anchor;
    const lengthBefore = fileOf(file).length;
    await m.first.locator('.card-suggestion').first()
      .getByRole('button', { name: 'Accept', exact: true }).click();
    await expect.poll(() => sidecarOf(file)?.suggestions?.[0]?.status).toBe('accepted');
    await expect.poll(() => fileOf(file)).toContain('(revised by fake agent)');

    // The seam: the accepted edit lands *before* the comment and pushes
    // every later offset along. The comment has to still be about the
    // words it was written about — and by exactly the distance the
    // document grew ahead of it, which "it moved" would not have caught
    // if the remap were off by a character.
    const after = sidecarOf(file).comments[0].anchor;
    const grew = fileOf(file).length - lengthBefore;
    expect(grew).toBeGreaterThan(0); // the edit really did insert text
    expect(after.from - before.from).toBe(grew);
    expect(after.quote).toBe(QUOTE);
    expect(fileOf(file).slice(after.from, after.to)).toBe(QUOTE);
    expect(after.orphaned).toBeFalsy();

    // ── resolve ──────────────────────────────────────────────────────
    await m.first.locator('.card-comment').first()
      .getByRole('button', { name: /resolve/i }).click();
    await expect.poll(() => sidecarOf(file)?.comments?.[0]?.status).toBe('resolved');
    // Settled work folds away; nothing is outstanding, so the filter pair
    // that only appears when something needs you goes too.
    await expect(m.first.getByRole('button', { name: /resolved & decided/i })).toBeVisible();
    await expect(m.first.locator('.review-counts')).not.toContainText('need you');
  });

  test('a second round builds on the first rather than replacing it', async () => {
    // Rounds accumulate: the counter keeps climbing, earlier work keeps
    // its stamp, and a reply to the new round does not disturb the old.
    m = await launch();
    const file = doc(m.dir, 'p/plan.md', DOC);
    await m.first.evaluate((f) => window.margin.openPath(f), file);
    await expect.poll(() => m.first.evaluate(() => !!document.querySelector('.cm-content'))).toBe(true);

    await selectQuote(m, DOC, QUOTE);
    await m.first.getByRole('button', { name: /\+ comment/i }).click();
    await m.first.locator('.card-composer textarea').first().fill('First question.');
    await m.first.locator('.card-composer .card-actions')
      .getByRole('button', { name: 'Comment', exact: true }).click();
    await expect.poll(() => sidecarOf(file)?.comments?.length).toBe(1);

    for (const round of [1, 2]) {
      await m.first.getByRole('button', { name: /submit for review/i }).click();
      await m.first.getByRole('button', { name: /send round/i }).click();
      await expect.poll(() => sidecarOf(file)?.round, { timeout: 60_000 }).toBe(round);
      await expect
        .poll(() => sidecarOf(file)?.comments?.[0]?.replies?.length, { timeout: 60_000 })
        .toBe(round);
    }

    const rounds = sidecarOf(file).comments[0].replies.map((r: { round: number }) => r.round);
    expect(rounds).toEqual([1, 2]);
    // The thread itself still carries the round it was opened in.
    expect(sidecarOf(file).comments[0].round).toBe(0);
  });
});
