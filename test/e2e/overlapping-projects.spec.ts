import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { launch, doc, windowFor, projectOf, type Margin } from './margin';

/**
 * Overlapping projects — Drew's `book/` + `chapter1/` + `chapter2/` case
 * (spec §6, scenarios 7–11, issue #171).
 *
 * Adopted separately, they are three projects. There is no mechanism for
 * this: it falls out of §1, because selecting a folder *is* the
 * declaration and nothing walks up looking for a better answer. These
 * are therefore mostly assertions — which is exactly why they are worth
 * writing down, since behaviour nobody built is behaviour nobody
 * notices breaking.
 *
 * The line they protect:
 *
 * - **A review is a property of the document.** The sidecar is a sibling
 *   of the file, so a comment made from one project is present from the
 *   other. The same reasoning that makes a review survive a rename.
 * - **Project state is a property of the project.** The discussion,
 *   notes, proposals and model preference belong to whichever folder was
 *   opened. Getting different context from `book/` than from
 *   `chapter1/` is the point of having chosen a folder.
 *
 * And the known cost, pinned here so it stays known rather than becoming
 * a surprise: `ReviewData.round` is per *document* while the discussion
 * is per *project*, so a round submitted from one advances a counter the
 * other reads. Scenario 11 asserts that pair together, because the
 * counter is only defensible if the round it counts really did carry the
 * other project's pending work.
 */

const DOC = (name: string) =>
  `# ${name}\n\nThe first paragraph is long enough to attract an edit from the agent.\n\n` +
  `The second paragraph mentions the staging window and is where the comment goes.\n`;

const QUOTE = 'the staging window';

const sidecarOf = (file: string) => {
  try {
    return JSON.parse(readFileSync(`${file}.review.json`, 'utf8'));
  } catch {
    return null;
  }
};

/** Declare a folder a project, the way adopting one does. */
function declare(dir: string, name: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'margin.json'), `${JSON.stringify({ version: 1, name }, null, 2)}\n`);
}

/** Open a folder through the menu path, answering the native pickers. */
async function openFolder(m: Margin, dir: string) {
  await m.app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }, dir);
  // Any live window, not `m.first`: opening a folder reuses the acting
  // window when it holds no document, so `m.first` frequently *becomes*
  // one of the project windows and may since have been closed.
  const live = m.app.windows().find((p) => p.url().includes('index.html'));
  if (!live) throw new Error('no window to open a folder from');
  await live.evaluate(() => window.margin.openFolderDialog());
}

/**
 * Wait for the round to *finish*, not for its first results.
 *
 * The fake agent keeps working after the reply lands — the suggestion,
 * then its notes, then a staged proposal — so anything asserting on
 * project state has to wait for the end of the turn.
 */
async function roundDone(page: Awaited<ReturnType<typeof windowFor>>) {
  await expect(page.getByText(/round \d+ returned/i)).toBeVisible({ timeout: 60_000 });
}

async function selectQuote(page: Awaited<ReturnType<typeof windowFor>>, source: string, quote: string) {
  const at = source.indexOf(quote);
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+Home');
  for (let i = 0; i < at; i++) await page.keyboard.press('ArrowRight');
  for (let i = 0; i < quote.length; i++) await page.keyboard.press('Shift+ArrowRight');
}

async function comment(page: Awaited<ReturnType<typeof windowFor>>, text: string) {
  await page.getByRole('button', { name: /\+ comment/i }).click();
  await page.locator('.card-composer textarea').first().fill(text);
  await page.locator('.card-composer .card-actions')
    .getByRole('button', { name: 'Comment', exact: true }).click();
}

/**
 * The fixture. `a-preface.md` sorts before `chapter1/`, so opening
 * `book/` seeds that window with the preface rather than with a nested
 * chapter — which would make every later "switch documents" step a
 * no-op that passes for the wrong reason.
 */
function theBook(dir: string) {
  const book = path.join(dir, 'book');
  const ch1 = path.join(book, 'chapter1');
  const ch2 = path.join(book, 'chapter2');
  const preface = doc(dir, 'book/a-preface.md', DOC('Preface'));
  const one = doc(dir, 'book/chapter1/one.md', DOC('One'));
  const two = doc(dir, 'book/chapter2/two.md', DOC('Two'));
  declare(book, 'Book');
  declare(ch1, 'Ch1');
  declare(ch2, 'Ch2');
  return { book, ch1, ch2, preface, one, two };
}

test.describe('overlapping projects', () => {
  let m: Margin;
  test.afterEach(async () => m?.close());

  test('three folders adopt as three projects', async () => {
    // Scenario 7. No ancestor walk, so `chapter1/` is its own project
    // even though `book/` declares itself directly above it.
    m = await launch();
    const f = theBook(m.dir);

    for (const dir of [f.book, f.ch1, f.ch2]) {
      expect(existsSync(path.join(dir, 'margin.json'))).toBe(true);
    }

    await openFolder(m, f.book);
    const bookWin = await windowFor(m.app, f.preface);
    await openFolder(m, f.ch1);
    const ch1Win = await windowFor(m.app, f.one);

    // Each window is in the folder that was opened, not the nearest or
    // the outermost declaration.
    expect(await projectOf(bookWin)).toEqual({ root: f.book, hasProject: true });
    expect(await projectOf(ch1Win)).toEqual({ root: f.ch1, hasProject: true });
    // The name comes from each folder's own margin.json.
    await expect(bookWin.locator('.explorer-root-name')).toHaveText('Book');
    await expect(ch1Win.locator('.explorer-root-name')).toHaveText('Ch1');
  });

  test('a review is the document’s, so it crosses the projects', async () => {
    // Scenario 8. Comment from `chapter1`, then reach the same file from
    // `book` — the sidecar is a sibling of the document, the same
    // property that makes a review survive a rename (§64).
    m = await launch();
    const f = theBook(m.dir);

    // `book` is opened first and deliberately stays open: closing the
    // last window quits the app on Linux (`window-all-closed`), which
    // would end the test rather than free the document.
    await openFolder(m, f.book);
    const bookWin = await windowFor(m.app, f.preface);
    await openFolder(m, f.ch1);
    const ch1Win = await windowFor(m.app, f.one);
    await selectQuote(ch1Win, DOC('One'), QUOTE);
    await comment(ch1Win, 'Written from the chapter1 project.');
    await expect.poll(() => sidecarOf(f.one)?.comments?.length).toBe(1);

    // One window per document, so the file has to be let go before the
    // other project can show it. Reaching for it while chapter1 holds it
    // focuses chapter1's window instead — the cross-project dedupe
    // recorded in #178.
    await ch1Win.close();
    await bookWin.evaluate((p) => window.margin.openInWindow(p), f.one);
    const fromBook = await windowFor(m.app, f.one);

    // The comment is there, and the window is still `book`.
    await expect(fromBook.locator('.card-comment')).toContainText('Written from the chapter1 project.');
    expect(await projectOf(fromBook)).toEqual({ root: f.book, hasProject: true });
  });

  test('the discussion is the project’s, so it does not cross', async () => {
    // Scenario 9. The other half of the rule: different folder, different
    // context. Getting `book`'s framing when you opened `chapter1` would
    // defeat the point of having chosen a folder.
    m = await launch();
    const f = theBook(m.dir);

    await openFolder(m, f.book);
    const bookWin = await windowFor(m.app, f.preface);
    await openFolder(m, f.ch1);
    const ch1Win = await windowFor(m.app, f.one);
    await ch1Win.locator('.dock-composer textarea').fill('Only chapter1 should see this.');
    await ch1Win.getByRole('button', { name: 'Queue', exact: true }).click();
    await expect(ch1Win.locator('.discussion-dock')).toContainText('1 queued');

    // `book` is then pointed at chapter1's *own* document. This is the
    // arrangement that discriminates: if the root were re-derived from
    // the file rather than carried by the window, `book` would be
    // showing chapter1's discussion right here.
    await ch1Win.close();
    await bookWin.evaluate((p) => window.margin.openInWindow(p), f.one);
    const bookOnOne = await windowFor(m.app, f.one);
    expect(await projectOf(bookOnOne)).toEqual({ root: f.book, hasProject: true });
    await bookOnOne.locator('.dock-head').click(); // expand
    await expect(bookOnOne.locator('.discussion-dock')).not.toContainText('Only chapter1');
    await expect(bookOnOne.locator('.discussion-dock')).not.toContainText('queued');

    // On disk too: two stores, not one shared file.
    expect(existsSync(path.join(f.ch1, '.margin', 'discussion.json'))).toBe(true);
    expect(existsSync(path.join(f.book, '.margin', 'discussion.json'))).toBe(false);
  });

  test('each explorer shows its own folder and no more', async () => {
    // Scenario 10. `book` contains the chapters, so it lists them;
    // `chapter1` is not above `chapter2`, so it cannot see it.
    m = await launch();
    const f = theBook(m.dir);

    await openFolder(m, f.book);
    const bookWin = await windowFor(m.app, f.preface);
    const bookFiles = bookWin.locator('.explorer-file');
    await expect(bookFiles.filter({ hasText: 'a-preface.md' })).toHaveCount(1);
    await expect(bookFiles.filter({ hasText: 'one.md' })).toHaveCount(1);
    await expect(bookFiles.filter({ hasText: 'two.md' })).toHaveCount(1);

    await openFolder(m, f.ch1);
    const ch1Win = await windowFor(m.app, f.one);
    const ch1Files = ch1Win.locator('.explorer-file');
    await expect(ch1Files.filter({ hasText: 'one.md' })).toHaveCount(1);
    await expect(ch1Files.filter({ hasText: 'two.md' })).toHaveCount(0);
    await expect(ch1Files.filter({ hasText: 'a-preface.md' })).toHaveCount(0);

    // And the explorer follows the *window's* project, not the open
    // file: pointing `book` at chapter1's document must not shrink its
    // tree to chapter1's. Scanning from the document instead of from the
    // root is a real bug this caught once — the session said `book`
    // while the sidebar said `Ch1`.
    await ch1Win.close();
    await bookWin.evaluate((p) => window.margin.openInWindow(p), f.one);
    const bookOnOne = await windowFor(m.app, f.one);
    await expect(bookOnOne.locator('.explorer-root-name')).toHaveText('Book');
    await expect(bookOnOne.locator('.explorer-file').filter({ hasText: 'two.md' })).toHaveCount(1);
  });

  test('a round from one project answers the other’s pending comment, and moves the counter both read', async () => {
    // Scenario 11, and the pair is the point. The shared counter is only
    // defensible if the round it counts genuinely carried the other
    // project's work — the agent's `list_review_state` returns the whole
    // sidecar, so it does.
    m = await launch();
    const f = theBook(m.dir);

    // A comment on one.md, made from `book`.
    await openFolder(m, f.book);
    const bookWin = await windowFor(m.app, f.preface);
    await bookWin.evaluate((p) => window.margin.openInWindow(p), f.one);
    const bookOnOne = await windowFor(m.app, f.one);
    await selectQuote(bookOnOne, DOC('One'), QUOTE);
    await comment(bookOnOne, 'Pending, left from the book project.');
    await expect.poll(() => sidecarOf(f.one)?.comments?.length).toBe(1);
    expect(sidecarOf(f.one).round).toBe(0);

    // Let the document go, then submit a round on it from `chapter1`.
    await bookOnOne.evaluate((p) => window.margin.openInWindow(p), f.preface);
    await windowFor(m.app, f.preface);
    await openFolder(m, f.ch1);
    const ch1Win = await windowFor(m.app, f.one);
    expect(await projectOf(ch1Win)).toEqual({ root: f.ch1, hasProject: true });

    await ch1Win.getByRole('button', { name: /submit for review/i }).click();
    await ch1Win.getByRole('button', { name: /send round/i }).click();
    await expect.poll(() => sidecarOf(f.one)?.round, { timeout: 60_000 }).toBe(1);

    // The half that makes the counter honest: the comment written in
    // `book` was sent and answered.
    await expect.poll(() => sidecarOf(f.one)?.comments?.[0]?.replies?.length, { timeout: 60_000 }).toBe(1);
    expect(sidecarOf(f.one).comments[0].replies[0]).toMatchObject({ author: 'agent', round: 1 });
    await roundDone(ch1Win);

    // And the counter `book` reads is the document's, so it has moved —
    // cosmetically odd, deliberately accepted, and true.
    await ch1Win.close();
    const backInBook = await windowFor(m.app, f.preface);
    await backInBook.evaluate((p) => window.margin.openInWindow(p), f.one);
    const bookAfter = await windowFor(m.app, f.one);
    await expect(bookAfter.locator('.status-chip').filter({ hasText: /Round 1/ })).toBeVisible();
    // The agent's notes, though, went to the project that ran the round.
    expect(existsSync(path.join(f.ch1, '.margin', 'agent-notes.md'))).toBe(true);
    expect(existsSync(path.join(f.book, '.margin', 'agent-notes.md'))).toBe(false);
  });
});
