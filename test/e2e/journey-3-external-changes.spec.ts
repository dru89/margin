import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'fs';
import path from 'path';
import { launch, doc, showing, type Margin } from './margin';

/**
 * Journey 3: the document changes underneath you (#135, from #131).
 *
 * Edit the file outside the app while it is open → have the change
 * adopted or contested → reopen with an anchor's text destroyed → rename
 * the file outside the app.
 *
 * The anchor and sidecar *rules* are covered at the unit tier
 * (`test:anchors`, `test:sidecar`). What only the running app reaches is
 * the machinery around them: the directory watcher, the decision between
 * adopting a change silently and asking, the conflict prompt's two
 * answers, and re-anchoring through a real load rather than a function
 * call. That is what this asserts.
 *
 * Everything is checked against what the author ends up with — the file
 * on disk, the sidecar, and whether the card still claims to be about
 * anything.
 */
const QUOTE = 'the staging window';
const DOC = [
  '# Notes',
  '',
  `Alpha paragraph mentions ${QUOTE} and its owner.`,
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

/** Seed a document with one comment anchored to QUOTE. */
function seed(dir: string, name = 'notes.md'): string {
  const file = doc(dir, `p/${name}`, DOC);
  const from = DOC.indexOf(QUOTE);
  writeFileSync(`${file}.review.json`, JSON.stringify({
    version: 1, document: name, round: 1,
    comments: [{
      id: 'c1', author: 'user', round: 1, createdAt: '2026-07-20T00:00:00Z',
      text: 'Which window exactly?', status: 'open', replies: [],
      anchor: {
        from, to: from + QUOTE.length, quote: QUOTE,
        prefix: DOC.slice(Math.max(0, from - 32), from),
        suffix: DOC.slice(from + QUOTE.length, from + QUOTE.length + 32),
      },
    }],
    suggestions: [], discussion: [],
  }, null, 2));
  return file;
}

const open = async (m: Margin, file: string) => {
  await m.first.evaluate((f) => window.margin.openPath(f), file);
  await expect(m.first.locator('.card-comment')).toBeVisible();
};

/** The card's orphan badge — "this no longer points at anything". */
const orphanBadge = (m: Margin) => m.first.locator('.card-comment').getByText('Text gone');

/**
 * The words the comment's highlight actually covers in the document.
 *
 * Checking only that no orphan badge appeared is too weak: an anchor that
 * silently *migrated* onto different text at its old offsets shows no
 * badge either, and that is the #126 failure exactly. This reads the
 * marked range itself. (Concatenated, since a mark can be split across
 * spans by wrapping or syntax highlighting.)
 */
const anchoredText = (m: Margin, id = 'c1') =>
  m.first.evaluate(
    (anchorId) =>
      [...document.querySelectorAll(`.cm-editor .anchor[data-anchor-id="${anchorId}"]`)]
        .map((el) => el.textContent ?? '')
        .join(''),
    id,
  );

test.describe('journey 3: the document changes underneath you', () => {
  let m: Margin;
  test.afterEach(async () => m?.close());

  test('a change made outside is adopted silently, and the comment keeps its place', async () => {
    // Nothing unsaved, so there is nothing to lose and nothing to ask.
    m = await launch();
    const file = seed(m.dir);
    await open(m, file);

    // Insert text *above* the anchor, which shifts every later offset.
    writeFileSync(file, DOC.replace('# Notes\n', '# Notes\n\nAdded outside Margin.\n'));

    await expect.poll(
      () => m.first.evaluate(() => document.querySelector('.cm-content')?.textContent ?? ''),
      { timeout: 15_000 },
    ).toContain('Added outside Margin');

    // The comment is still about the words it was written about — it did
    // not orphan, and did not migrate onto whatever now sits at its old
    // offsets (#126).
    await expect(m.first.locator('.card-comment')).toBeVisible();
    await expect(orphanBadge(m)).toHaveCount(0);
    // Not just "no badge" — the highlight covers the same words it did
    // before the file grew above it.
    await expect.poll(() => anchoredText(m), { timeout: 15_000 }).toBe(QUOTE);
  });

  test('with unsaved edits it asks, and "Keep mine" wins', async () => {
    m = await launch();
    const file = seed(m.dir);
    await open(m, file);

    // Type without waiting for autosave, then change the file underneath.
    await m.first.locator('.cm-content').click();
    await m.first.keyboard.press('ControlOrMeta+End');
    await m.first.keyboard.type('\n\nMine.');
    writeFileSync(file, `${DOC}\nTheirs.\n`);

    await expect(m.first.locator('.conflict-bar')).toBeVisible({ timeout: 15_000 });
    await m.first.getByRole('button', { name: 'Keep mine' }).click();

    await expect.poll(() => readFileSync(file, 'utf8'), { timeout: 15_000 }).toContain('Mine.');
    expect(readFileSync(file, 'utf8')).not.toContain('Theirs.');
    await expect(m.first.locator('.conflict-bar')).toHaveCount(0);
  });

  test('with unsaved edits, "Reload theirs" discards mine', async () => {
    // The other answer, and the destructive one — worth pinning that it
    // really does drop the local edit rather than merging.
    m = await launch();
    const file = seed(m.dir);
    await open(m, file);

    await m.first.locator('.cm-content').click();
    await m.first.keyboard.press('ControlOrMeta+End');
    await m.first.keyboard.type('\n\nMine.');
    writeFileSync(file, `${DOC}\nTheirs.\n`);

    await expect(m.first.locator('.conflict-bar')).toBeVisible({ timeout: 15_000 });
    await m.first.getByRole('button', { name: 'Reload theirs' }).click();

    await expect.poll(
      () => m.first.evaluate(() => document.querySelector('.cm-content')?.textContent ?? ''),
      { timeout: 15_000 },
    ).toContain('Theirs.');
    expect(await m.first.evaluate(() => document.querySelector('.cm-content')?.textContent ?? ''))
      .not.toContain('Mine.');
    expect(readFileSync(file, 'utf8')).not.toContain('Mine.');
  });

  test('text edited away leaves the comment orphaned, not pointing at a stranger', async () => {
    // The #126 failure mode: an anchor whose words are gone must say so,
    // rather than adopting whatever text now occupies its offsets.
    m = await launch();
    const file = seed(m.dir);
    await open(m, file);

    writeFileSync(file, DOC.replace(QUOTE, 'a completely different subject'));

    await expect(orphanBadge(m)).toBeVisible({ timeout: 15_000 });
    // Its stored quote survives as the only remaining evidence of what it
    // was about (spec §2).
    await expect(m.first.locator('.card-comment')).toContainText(QUOTE);
  });

  test('an external edit already applied before opening is re-anchored on load', async () => {
    // The same rule reached by the other route: not the watcher, but a
    // cold load against a file that moved on while the app was closed.
    m = await launch();
    const file = seed(m.dir);
    writeFileSync(file, DOC.replace('# Notes\n', '# Notes\n\nAdded while Margin was closed.\n'));

    await open(m, file);
    await expect(orphanBadge(m)).toHaveCount(0);
    await expect.poll(() => anchoredText(m), { timeout: 15_000 }).toBe(QUOTE);
  });

  test('renaming the file outside Margin brings its review along', async () => {
    m = await launch();
    const file = seed(m.dir);
    await open(m, file);
    expect(sidecarOf(file).comments).toHaveLength(1);

    const renamed = path.join(path.dirname(file), 'renamed.md');
    renameSync(file, renamed);
    await m.first.evaluate((f) => window.margin.openPath(f), renamed);
    await expect.poll(() => showing(m.first)).toBe('renamed.md');

    // The review followed, and the comment still points at its text.
    await expect.poll(() => sidecarOf(renamed)?.comments?.length, { timeout: 15_000 }).toBe(1);
    await expect(orphanBadge(m)).toHaveCount(0);
    await expect.poll(() => anchoredText(m), { timeout: 15_000 }).toBe(QUOTE);
    // Adoption renames rather than copies: nothing is left behind to be
    // adopted a second time by some other document.
    expect(existsSync(`${file}.review.json`)).toBe(false);
  });
});
