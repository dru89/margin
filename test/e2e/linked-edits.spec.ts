import { test, expect } from '@playwright/test';
import { writeFileSync } from 'fs';
import { readFileSync } from 'fs';
import { launch, doc, type Margin } from './margin';

/**
 * A suggestion linked to the comment it answers (spec §7, #100).
 *
 * Two things are asserted. That the link renders in both directions from
 * the one field that stores it — a second field on the thread could
 * disagree with the first, which is why there isn't one. And that
 * deciding every linked edit does **not** resolve the thread: the edits
 * being handled is not evidence the comment is answered, and resolving
 * stays a deliberate act by the author.
 */
const DOC = [
  '# Doc',
  '',
  'The C+I team owns the first thing.',
  '',
  'The C+I roadmap covers the second thing.',
  '',
].join('\n');

const at = (quote: string) => {
  const from = DOC.indexOf(quote);
  if (from < 0) throw new Error(`fixture quote missing: ${quote}`);
  return { from, to: from + quote.length, quote };
};

function seed(dir: string): string {
  const file = doc(dir, 'p/doc.md', DOC);
  writeFileSync(`${file}.review.json`, JSON.stringify({
    version: 1, document: 'doc.md', round: 2,
    comments: [{
      id: 'th-naming', author: 'user', round: 1, createdAt: '2026-07-20T00:00:00Z',
      text: 'Use the full name everywhere — C+I is wrong.',
      anchor: at('The C+I team'), status: 'open', seenRound: 2,
      replies: [{
        id: 'rp1', author: 'agent', round: 2, createdAt: '2026-07-21T00:00:00Z',
        text: 'Agreed, proposed both.',
      }],
    }],
    suggestions: [
      {
        id: 'sg-one', author: 'agent', round: 2, createdAt: '2026-07-21T00:00:00Z',
        anchor: at('The C+I team'), replacement: 'The C&I team',
        note: 'First occurrence.', status: 'pending', inReplyTo: 'th-naming',
      },
      {
        id: 'sg-two', author: 'agent', round: 2, createdAt: '2026-07-21T00:00:00Z',
        anchor: at('The C+I roadmap'), replacement: 'The C&I roadmap',
        note: 'Second occurrence.', status: 'pending', inReplyTo: 'th-naming',
      },
    ],
    discussion: [],
  }, null, 2));
  return file;
}

const sidecarOf = (file: string) => JSON.parse(readFileSync(`${file}.review.json`, 'utf8'));

const open = async (m: Margin, file: string) => {
  await m.first.evaluate((f) => window.margin.openPath(f), file);
  await expect(m.first.locator('.card-comment')).toBeVisible();
};

test.describe('edits linked to the comment they answer', () => {
  let m: Margin;
  test.afterEach(async () => m?.close());

  test('the thread points at its edits and each edit points back', async () => {
    m = await launch();
    const file = seed(m.dir);
    await open(m, file);

    // Several edits group under one row rather than a stack of chips.
    const thread = m.first.locator('#card-th-naming');
    await expect(thread.getByRole('button', { name: /answered by 2 edits/ })).toBeVisible();
    await thread.getByRole('button', { name: /answered by 2 edits/ }).click();
    await expect(thread.locator('.pointer-row')).toHaveCount(2);

    // And the other direction, from the same stored field.
    await expect(
      m.first.locator('#card-sg-one').getByRole('button', { name: /answers/ }),
    ).toBeVisible();
  });

  test('deciding every linked edit does not resolve the thread', async () => {
    // The edits being handled is not evidence the comment is answered —
    // the author may have meant something broader than what Claude found.
    m = await launch();
    const file = seed(m.dir);
    await open(m, file);

    for (const id of ['#card-sg-one', '#card-sg-two']) {
      await m.first.locator(id).getByRole('button', { name: 'Accept', exact: true }).click();
    }
    await expect.poll(() =>
      sidecarOf(file).suggestions.map((s: { status: string }) => s.status).join(','),
    ).toBe('accepted,accepted');

    // Still open, and still open after a reload — nothing resolved it.
    expect(sidecarOf(file).comments[0].status).toBe('open');
    await expect(m.first.locator('#card-th-naming')).toBeVisible();
  });

  test('decided edits leave a record on the thread rather than vanishing', async () => {
    // That line is the evidence the author would resolve the thread on,
    // so it collapses to a record instead of disappearing.
    m = await launch();
    const file = seed(m.dir);
    await open(m, file);

    await m.first.locator('#card-sg-one').getByRole('button', { name: 'Accept', exact: true }).click();
    await expect.poll(() => sidecarOf(file).suggestions[0].status).toBe('accepted');

    const thread = m.first.locator('#card-th-naming');
    await expect(thread.locator('.card-links-decided')).toContainText('1 edit accepted');
    // The one still pending is now a row of its own, not a group of two.
    await expect(thread.getByRole('button', { name: /answered by an edit/ })).toBeVisible();
  });
});
