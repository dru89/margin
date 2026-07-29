import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { launch, projectDoc, type Margin } from './margin';

/**
 * Drafting: the composer's anchor, and rewriting what hasn't been sent
 * (spec §8, #121 and #89).
 *
 * The assertions are on the sidecar, because that is what the author ends
 * up with. A composer that silently re-points at a new selection produces
 * a comment attached to text it was never written about — and nothing on
 * screen says so, which is exactly why this is worth a journey rather than
 * a unit case.
 */
const DOC = [
  '# Doc',
  '',
  'Alpha paragraph is the first one.',
  '',
  'Beta paragraph is the second one.',
  '',
].join('\n');

const sidecarOf = (file: string) => {
  try {
    return JSON.parse(readFileSync(`${file}.review.json`, 'utf8'));
  } catch {
    return null;
  }
};

/** Select the first `chars` characters of the line containing `lineText`. */
async function select(m: Margin, lineText: string, chars: number) {
  await m.first.locator('.cm-line', { hasText: lineText }).first().click();
  await m.first.keyboard.press('Home');
  for (let i = 0; i < chars; i++) await m.first.keyboard.press('Shift+ArrowRight');
}

const composerBox = (m: Margin) => m.first.locator('.card-composer textarea').first();
const commit = (m: Margin) =>
  m.first.locator('.card-composer .card-actions').getByRole('button', { name: 'Comment', exact: true });

async function open(m: Margin, file: string) {
  await m.first.evaluate((f) => window.margin.openPath(f), file);
  await expect.poll(() => m.first.evaluate(() => !!document.querySelector('.cm-content'))).toBe(true);
}

test.describe('drafting a comment', () => {
  let m: Margin;
  test.afterEach(async () => m?.close());

  test('a composer holding text keeps its anchor when you select elsewhere', async () => {
    m = await launch();
    const file = projectDoc(m.dir, 'p/doc.md', DOC);
    await open(m, file);

    await select(m, 'Alpha paragraph', 5);
    await m.first.getByRole('button', { name: /\+ comment/i }).click();
    await composerBox(m).fill('this is about Alpha');

    // The misclick: different text, and + Comment again. The draft must
    // stay where it was written, not follow the selection.
    await select(m, 'Beta paragraph', 4);
    await m.first.getByRole('button', { name: /\+ comment/i }).click();
    await expect(composerBox(m)).toHaveValue('this is about Alpha');

    await commit(m).click();
    await expect.poll(() => sidecarOf(file)?.comments?.[0]?.anchor?.quote).toBe('Alpha');
    expect(sidecarOf(file).comments[0].text).toBe('this is about Alpha');
  });

  test('a draft whose text is deleted commits as orphaned, not onto its neighbours', async () => {
    m = await launch();
    const file = projectDoc(m.dir, 'p/doc.md', DOC);
    await open(m, file);

    await select(m, 'Alpha paragraph', 5);
    await m.first.getByRole('button', { name: /\+ comment/i }).click();
    await composerBox(m).fill('about the word Alpha');

    // Now delete the very words it is about. Offsets shift; without
    // remapping, the draft would land on whatever slid into their place.
    await select(m, 'Alpha paragraph', 5);
    await m.first.keyboard.press('Backspace');
    await commit(m).click();

    await expect.poll(() => sidecarOf(file)?.comments?.[0]?.anchor?.orphaned).toBe(true);
    expect(sidecarOf(file).comments[0].anchor.quote).toBe('Alpha');
  });

  test('an empty composer re-targets freely', async () => {
    m = await launch();
    const file = projectDoc(m.dir, 'p/doc.md', DOC);
    await open(m, file);

    await select(m, 'Alpha paragraph', 5);
    await m.first.getByRole('button', { name: /\+ comment/i }).click();
    // Nothing typed — the ordinary case of grabbing the wrong words.
    await select(m, 'Beta paragraph', 4);
    await m.first.getByRole('button', { name: /\+ comment/i }).click();
    await composerBox(m).fill('this is about Beta');
    await commit(m).click();

    await expect.poll(() => sidecarOf(file)?.comments?.[0]?.anchor?.quote).toBe('Beta');
  });
});

test.describe('editing what has not been sent', () => {
  let m: Margin;
  test.afterEach(async () => m?.close());

  const draftComment = async (file: string) => {
    await open(m, file);
    await select(m, 'Alpha paragraph', 5);
    await m.first.getByRole('button', { name: /\+ comment/i }).click();
    await composerBox(m).fill('first thoughts');
    await commit(m).click();
    await expect.poll(() => sidecarOf(file)?.comments?.length).toBe(1);
  };

  test('a draft comment can be rewritten in place', async () => {
    m = await launch();
    const file = projectDoc(m.dir, 'p/doc.md', DOC);
    await draftComment(file);

    await m.first.locator('.card-comment').first()
      .getByRole('button', { name: 'Edit', exact: true }).click();
    await m.first.locator('.card-comment .msg-edit textarea').first().fill('second thoughts');
    await m.first.locator('.card-comment .msg-edit').getByRole('button', { name: 'Save' }).click();

    await expect.poll(() => sidecarOf(file)?.comments?.[0]?.text).toBe('second thoughts');
    // Rewriting is not re-anchoring: the words it is about do not move.
    expect(sidecarOf(file).comments[0].anchor.quote).toBe('Alpha');
  });

  test('a draft comment can be taken back', async () => {
    m = await launch();
    const file = projectDoc(m.dir, 'p/doc.md', DOC);
    await draftComment(file);

    await m.first.locator('.card-comment').first()
      .getByRole('button', { name: 'Delete', exact: true }).click();
    await expect.poll(() => sidecarOf(file)?.comments?.length).toBe(0);
  });

  test('a round carries the saved wording, not an edit still in the box', async () => {
    // Submitting is never blocked, so an open edit box has to lose rather
    // than commit text the author never confirmed. What it must not do is
    // send half a rewrite — the popover says so before it happens.
    m = await launch();
    const file = projectDoc(m.dir, 'p/doc.md', DOC);
    await draftComment(file);

    await m.first.locator('.card-comment').first()
      .getByRole('button', { name: 'Edit', exact: true }).click();
    await m.first.locator('.card-comment .msg-edit textarea').first().fill('half a rewr');

    await m.first.getByRole('button', { name: /submit for review/i }).click();
    await expect(m.first.getByText(/haven’t saved will be discarded/)).toBeVisible();
    await m.first.getByRole('button', { name: /send round/i }).click();
    await expect.poll(() => sidecarOf(file)?.round, { timeout: 60_000 }).toBe(1);

    expect(sidecarOf(file).comments[0].text).toBe('first thoughts');
  });

  test('once submitted, a comment is a record and stops being editable', async () => {
    m = await launch();
    const file = projectDoc(m.dir, 'p/doc.md', DOC);
    await draftComment(file);

    await m.first.getByRole('button', { name: /submit for review/i }).click();
    await m.first.getByRole('button', { name: /send round/i }).click();
    await expect.poll(() => sidecarOf(file)?.round, { timeout: 60_000 }).toBe(1);

    // The card is still there; what it offers has changed.
    await expect(m.first.locator('.card-comment').first()).toBeVisible();
    await expect(
      m.first.locator('.card-comment').first().getByRole('button', { name: 'Edit', exact: true }),
    ).toHaveCount(0);
  });
});
