import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { launch, doc, showing, type Margin } from './margin';

/**
 * A draft comment belongs to its document, not to the window (spec §8).
 *
 * Documents in one project share a window, so the composer's state
 * outlived the document it was written for: the typing followed the
 * window to the next file and the original had nothing to come back to.
 * That is the #121 failure — a comment attached to text it was not
 * written about — arriving by a route no single-document test can see,
 * which is what makes this a journey.
 */
const A = '# A\n\nAlpha paragraph in the first file.\n';
const B = '# B\n\nBeta paragraph in the second file.\n';

const sidecarOf = (file: string) => {
  try {
    return JSON.parse(readFileSync(`${file}.review.json`, 'utf8'));
  } catch {
    return null;
  }
};

/**
 * Select `chars` characters of a line and open the composer on them.
 *
 * Deliberately does not type: an earlier version of this file filled the
 * box on the way in, which cleared the leak it was supposed to catch and
 * passed against the unfixed build.
 */
async function compose(m: Margin, line: string, chars: number) {
  await m.first.locator('.cm-line', { hasText: line }).first().click();
  await m.first.keyboard.press('Home');
  for (let i = 0; i < chars; i++) await m.first.keyboard.press('Shift+ArrowRight');
  await m.first.getByRole('button', { name: /\+ comment/i }).click();
  return m.first.locator('.card-composer textarea').first();
}

const openDoc = async (m: Margin, file: string) => {
  await m.first.evaluate((f) => window.margin.openPath(f), file);
  await expect.poll(() => m.first.evaluate(() => !!document.querySelector('.cm-content'))).toBe(true);
};

const go = async (m: Margin, name: string) => {
  await m.first.getByRole('button', { name, exact: true }).click();
  await expect.poll(() => showing(m.first)).toBe(name);
};

test.describe('a draft comment and the file it belongs to', () => {
  let m: Margin;
  test.afterEach(async () => m?.close());

  test('does not follow the window to another document', async () => {
    m = await launch();
    const a = doc(m.dir, 'p/a.md', A);
    const b = doc(m.dir, 'p/b.md', B);
    await openDoc(m, a);
    await (await compose(m, 'Alpha paragraph', 5)).fill('this is about the A file');

    await go(m, 'b.md');
    // The composer belongs to a.md and stays there.
    await expect(m.first.locator('.card-composer')).toHaveCount(0);

    // The one opened here starts empty. Nothing is typed before this
    // assertion, or it would clear the very leak it is checking for.
    const box = await compose(m, 'Beta paragraph', 4);
    await expect(box).toHaveValue('');

    await box.fill('this is about the B file');
    await m.first.locator('.card-composer .card-actions')
      .getByRole('button', { name: 'Comment', exact: true }).click();
    await expect.poll(() => sidecarOf(b)?.comments?.[0]?.text).toBe('this is about the B file');
    expect(sidecarOf(b).comments[0].anchor.quote).toBe('Beta');
  });

  test('is still there when you come back to it', async () => {
    // Switching files is often *because* of what is being drafted — a
    // chip in a comment is a link to another file (§9) — so it cannot
    // cost the comment.
    m = await launch();
    const a = doc(m.dir, 'p/a.md', A);
    doc(m.dir, 'p/b.md', B);
    await openDoc(m, a);
    await (await compose(m, 'Alpha paragraph', 5)).fill('this is about the A file');

    await go(m, 'b.md');
    await go(m, 'a.md');

    await expect(m.first.locator('.card-composer textarea').first())
      .toHaveValue('this is about the A file');
    await m.first.locator('.card-composer .card-actions')
      .getByRole('button', { name: 'Comment', exact: true }).click();
    await expect.poll(() => sidecarOf(a)?.comments?.[0]?.anchor?.quote).toBe('Alpha');
  });

  test('an empty composer is not worth parking', async () => {
    m = await launch();
    const a = doc(m.dir, 'p/a.md', A);
    doc(m.dir, 'p/b.md', B);
    await openDoc(m, a);
    await compose(m, 'Alpha paragraph', 5);

    await go(m, 'b.md');
    await go(m, 'a.md');
    // Nothing was typed, so there is nothing to bring back — and a
    // composer reopening by itself would be a surprise, not a courtesy.
    await expect(m.first.locator('.card-composer')).toHaveCount(0);
  });
});
