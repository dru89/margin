import { test, expect } from '@playwright/test';
import { writeFileSync } from 'fs';
import path from 'path';
import { launch, doc, type Margin } from './margin';

/**
 * The review surface's structural rules (spec §4–§5).
 *
 * These assert decisions, not markup: what order cards come in, and that
 * two controls over one piece of state agree. A desynced toggle is the
 * dangerous one — the pane would claim to be showing everything while
 * hiding half of it, and nothing on screen would say so.
 */
const TEXT = [
  '# Doc',
  '',
  'Alpha paragraph mentions the first phrase here.',
  '',
  'Beta paragraph mentions the second phrase here.',
  '',
  'Gamma paragraph mentions the third phrase here.',
  '',
  'Delta paragraph mentions the fourth phrase here.',
  '',
  'Epsilon paragraph mentions the fifth phrase here.',
  '',
].join('\n');

const ROUND = 5;
const anchor = (quote: string) => {
  const from = TEXT.indexOf(quote);
  if (from < 0) throw new Error(`fixture quote missing: ${quote}`);
  return { from, to: from + quote.length, quote };
};
const thread = (id: string, quote: string, answered: boolean) => ({
  id, author: 'user', round: 1, createdAt: '2026-07-20T00:00:00Z',
  text: `question about ${quote}`, anchor: anchor(quote), status: 'open',
  replies: answered
    ? [{ id: `${id}r`, author: 'agent', round: ROUND, createdAt: '2026-07-25T00:00:00Z', text: 'an answer' }]
    : [],
});
const suggestion = (id: string, quote: string) => ({
  id, author: 'agent', round: ROUND, createdAt: '2026-07-25T00:00:00Z',
  anchor: anchor(quote), replacement: `${quote} (revised)`, note: 'because', status: 'pending',
});

/** Anchors are deliberately out of order here; the pane must sort them. */
function seed(dir: string): string {
  const file = doc(dir, 'p/doc.md', TEXT);
  writeFileSync(`${file}.review.json`, JSON.stringify({
    version: 1, document: 'doc.md', round: ROUND,
    comments: [
      thread('t-eps', 'fifth phrase', true),
      thread('t-alpha', 'first phrase', true),
      thread('t-gamma', 'third phrase', true),
      // Unanswered and mine, so it is the one thing the filter removes.
      thread('t-mine', 'Delta paragraph', false),
    ],
    suggestions: [suggestion('s-delta', 'fourth phrase'), suggestion('s-beta', 'second phrase')],
    discussion: [],
  }, null, 2));
  return file;
}

const openSeeded = async (m: Margin) => {
  const file = seed(m.dir);
  await m.first.evaluate((f) => window.margin.openPath(f), file);
  await expect(m.first.locator('.round-header')).toBeVisible();
  return file;
};

test.describe('review surface', () => {
  let m: Margin;
  test.afterEach(async () => m?.close());

  test('threads and suggestions are one list in document order', async () => {
    m = await launch();
    await openSeeded(m);
    // Seeded out of order; expected order follows the document.
    await expect
      .poll(() => m.first.evaluate(() =>
        [...document.querySelectorAll('.card-comment,.card-suggestion')].map((c) => c.id),
      ))
      .toEqual([
        'card-t-alpha', 'card-s-beta', 'card-t-gamma',
        'card-t-mine', 'card-s-delta', 'card-t-eps',
      ]);
  });

  test('the round header caps its jumps and hands the rest to the filter', async () => {
    m = await launch();
    await openSeeded(m);
    await expect(m.first.locator('.round-jump:not(.round-jump-more)')).toHaveCount(3);
    await expect(m.first.locator('.round-jump-more')).toHaveText(/\+2 more/);
  });

  test('the overflow jump and the filter pair share one state', async () => {
    // Two controls over one piece of state. If they drift, the pane claims
    // to show everything while hiding half of it, with nothing to say so.
    m = await launch();
    await openSeeded(m);
    const more = m.first.locator('.round-jump-more');
    const all = m.first.getByRole('button', { name: 'All', exact: true });
    const needYou = m.first.getByRole('button', { name: 'Need you', exact: true });
    const cards = m.first.locator('.card-comment,.card-suggestion');

    await expect(cards).toHaveCount(6);
    await expect(more).toHaveAttribute('aria-pressed', 'false');

    await more.click();
    // Everything except the thread waiting on Claude: three answered
    // threads plus two undecided suggestions all want something from you.
    await expect(cards).toHaveCount(5);
    await expect(more).toHaveAttribute('aria-pressed', 'true');
    await expect(needYou).toHaveClass(/\bon\b/);

    await more.click();
    await expect(cards).toHaveCount(6);
    await expect(more).toHaveAttribute('aria-pressed', 'false');
    await expect(all).toHaveClass(/\bon\b/);

    // Driving it from the other end keeps the jump in step.
    await needYou.click();
    await expect(more).toHaveAttribute('aria-pressed', 'true');
    await expect(cards).toHaveCount(5);
  });

  test('the round header clears itself once nothing in it is outstanding', async () => {
    m = await launch();
    await openSeeded(m);
    // Read every answered thread...
    for (const id of ['t-alpha', 't-gamma', 't-eps']) {
      await m.first.locator(`#card-${id}`).click();
      await m.first.waitForTimeout(150);
    }
    await expect(m.first.locator('.round-header')).toBeVisible(); // suggestions still pending
    // ...and decide every suggestion.
    for (const id of ['s-beta', 's-delta']) {
      await m.first.locator(`#card-${id}`).getByRole('button', { name: 'Accept', exact: true }).click();
      await m.first.waitForTimeout(250);
    }
    await expect(m.first.locator('.round-header')).toHaveCount(0);
  });
});
