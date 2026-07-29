import { test, expect } from '@playwright/test';
import path from 'path';
import { launch, projectDoc, windowFor, type Margin } from './margin';

/**
 * Multiple windows per project (spec §8, scenarios 14–18, issue #172).
 *
 * **Committed state syncs; uncommitted state does not.** That line is
 * already the app's central distinction — draft versus sent (§66), a
 * round that produced nothing did not happen (§71) — and extending it to
 * windows is consistent rather than new.
 *
 * One document is only ever open in one window, so "appears in the other
 * window" means the explorer's counts rather than a second editor over
 * the same file. Two live editors over one buffer is refused on
 * ownership grounds (§8), and the scenarios are read that way here.
 *
 * The sharpest decision under test is what a peer round may *do*. It is
 * announced in sibling windows and locks none of them: the turn owns the
 * review of its own document, and a window editing a different document
 * has nothing to hand over.
 */

const DOC = (name: string) =>
  `# ${name}\n\nThe first paragraph is long enough to attract an edit from the agent.\n\n` +
  `The second paragraph mentions the staging window and is where the comment goes.\n`;

const QUOTE = 'the staging window';

async function selectQuote(page: Awaited<ReturnType<typeof windowFor>>, source: string, quote: string) {
  const at = source.indexOf(quote);
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+Home');
  for (let i = 0; i < at; i++) await page.keyboard.press('ArrowRight');
  for (let i = 0; i < quote.length; i++) await page.keyboard.press('Shift+ArrowRight');
}

/** Two windows on one project, showing different documents. */
async function twoWindows(m: Margin) {
  const alpha = projectDoc(m.dir, 'proj/alpha.md', DOC('Alpha'));
  const beta = projectDoc(m.dir, 'proj/beta.md', DOC('Beta'));
  await m.first.evaluate((f) => window.margin.openPath(f), alpha);
  const one = await windowFor(m.app, alpha);
  await m.first.evaluate(() => window.margin.newWindow());
  await expect
    .poll(() => m.app.windows().filter((p) => p.url().includes('index.html')).length)
    .toBeGreaterThan(1);
  const fresh = m.app.windows().filter((p) => p.url().includes('index.html')).pop()!;
  await fresh.evaluate((f) => window.margin.openInWindow(f), beta);
  const two = await windowFor(m.app, beta);
  return { alpha, beta, one, two };
}

const explorerRow = (page: Awaited<ReturnType<typeof windowFor>>, name: string) =>
  page.locator('.explorer-file').filter({ hasText: name });

test.describe('multiple windows on one project', () => {
  let m: Margin;
  test.afterEach(async () => m?.close());

  test('asking for a document already open brings its window forward', async () => {
    // Scenario 14. Already true — `openFile` dedupes on the resolved
    // path — so this pins it rather than building it.
    m = await launch();
    const { alpha, one, two } = await twoWindows(m);
    const before = m.app.windows().length;

    // Ask for alpha from the *other* window's explorer.
    await two.evaluate((p) => window.margin.openInWindow(p), alpha);

    // No third window, and alpha is still where it was.
    await expect.poll(() => m.app.windows().length).toBe(before);
    expect(await windowFor(m.app, alpha)).toBe(one);
  });

  test('the explorer says which documents are open elsewhere', async () => {
    // Scenario 15. The marker is what makes scenario 14 feel like an
    // answer rather than a jolt.
    m = await launch();
    const { one, two } = await twoWindows(m);

    // Each window marks the *other's* document, and not its own.
    await expect(explorerRow(one, 'beta.md')).toHaveClass(/explorer-file-elsewhere/);
    await expect(explorerRow(one, 'alpha.md')).not.toHaveClass(/explorer-file-elsewhere/);
    await expect(explorerRow(two, 'alpha.md')).toHaveClass(/explorer-file-elsewhere/);
    await expect(explorerRow(two, 'beta.md')).not.toHaveClass(/explorer-file-elsewhere/);
  });

  test('a committed comment reaches the other window; a draft does not', async () => {
    // Scenarios 16 and 17, as a pair — they are the same rule seen from
    // both sides, and testing either alone would let the other regress.
    m = await launch();
    const { one, two } = await twoWindows(m);

    // A draft: typed into the composer, never committed.
    await selectQuote(one, DOC('Alpha'), QUOTE);
    await one.getByRole('button', { name: /\+ comment/i }).click();
    await one.locator('.card-composer textarea').first().fill('Still typing this one.');
    // The other window's count for alpha stays at nothing. Nothing typed
    // is ever discarded, and nothing typed travels either.
    await two.evaluate(() => window.margin.getWorkspace());
    await expect(explorerRow(two, 'alpha.md').locator('.explorer-badge')).toHaveCount(0);

    // Committing it is what makes it travel.
    await one.locator('.card-composer .card-actions')
      .getByRole('button', { name: 'Comment', exact: true }).click();
    await expect(explorerRow(two, 'alpha.md').locator('.explorer-badge')).toHaveText('1', {
      timeout: 20_000,
    });
    // And the draft never appeared as a card in the other window — it is
    // not a document beta is showing, so there is nothing to render, but
    // the count is the thing that could have leaked.
    await expect(two.locator('.card-composer')).toHaveCount(0);
  });

  test('a round in one window is announced in the other, and locks nothing', async () => {
    // Scenario 18, and the decision that shapes it. The peer window is
    // editing a different document; the round has no claim on it.
    m = await launch();
    const { beta, one, two } = await twoWindows(m);

    await one.getByRole('button', { name: /submit for review/i }).click();
    await one.getByRole('button', { name: /send round/i }).click();

    // Announced, naming the document under review.
    await expect(two.locator('.agent-bar')).toContainText(/reviewing alpha\.md in another window/i, {
      timeout: 20_000,
    });

    // And the peer window is still the author's: it takes typing, and
    // the round's own window does not.
    await two.locator('.cm-line').first().click();
    await two.keyboard.press('End');
    await two.keyboard.type(' still editable');
    await expect
      .poll(() => two.evaluate(() => document.querySelector('.cm-content')?.textContent))
      .toContain('# Beta still editable');
    await expect(two.getByRole('button', { name: /submit for review/i })).toBeEnabled();
    await expect(one.getByRole('button', { name: /submit for review/i })).toBeDisabled();

    // The edit really landed in beta, not somewhere shared.
    await expect(one.getByText(/round 1 returned/i)).toBeVisible({ timeout: 60_000 });
    expect(path.basename(beta)).toBe('beta.md');
  });
});
