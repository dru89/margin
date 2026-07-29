import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'fs';
import path from 'path';
import { launch, projectDoc, windowFor, type Margin } from './margin';

/**
 * One review round per document (spec §7 scenarios 12 and 13, #170).
 *
 * The failure being prevented is the only one in this area that
 * *corrupts*: two turns writing one review sidecar. It is mostly
 * unreachable already — `openFile` dedupes on the resolved path, so a
 * document is open in one window — and the case that remains is the
 * symlink, because `path.resolve` does not follow one. Two paths, two
 * windows, one file.
 *
 * The lock is the document's, so the other half matters just as much:
 * two windows submitting on *different* documents must both run. A lock
 * that is too broad would be indistinguishable from a working one until
 * the day it blocked real work.
 */

const DOC = '# Plan\n\nThe first paragraph is long enough to attract an edit from the agent.\n';

const sidecarOf = (file: string) => {
  try {
    return JSON.parse(readFileSync(`${file}.review.json`, 'utf8'));
  } catch {
    return null;
  }
};

/** Open a path in a window of its own, then hand that window back. */
async function openInNewWindow(m: Margin, file: string) {
  await m.first.evaluate((f) => window.margin.openPath(f), file);
  return windowFor(m.app, file);
}

const submit = async (page: Awaited<ReturnType<typeof windowFor>>) => {
  await page.getByRole('button', { name: /submit for review/i }).click();
  await page.getByRole('button', { name: /send round/i }).click();
};

test.describe('the round lock', () => {
  let m: Margin;
  test.afterEach(async () => m?.close());

  test('two paths to one document cannot run two rounds', async () => {
    // Scenario 12. The symlink is what defeats the resolved-path dedupe
    // and puts one file in two windows — which overlapping projects make
    // more likely, since a chapter gets linked into a second book.
    m = await launch();
    const real = projectDoc(m.dir, 'chapters/one.md', DOC);
    const linkedDir = path.join(m.dir, 'linked');
    mkdirSync(linkedDir, { recursive: true });
    writeFileSync(path.join(linkedDir, 'margin.json'), `${JSON.stringify({ version: 1 })}\n`);
    const link = path.join(linkedDir, 'one.md');
    symlinkSync(real, link);

    const viaReal = await openInNewWindow(m, real);
    const viaLink = await openInNewWindow(m, link);
    // The premise: the dedupe really did fail and there are two windows.
    expect(viaReal).not.toBe(viaLink);

    await submit(viaReal);
    await expect.poll(() => sidecarOf(real)?.round, { timeout: 30_000 }).toBe(1);

    // The second submit, while the first turn is still working.
    await submit(viaLink);
    // Refused, and it says where the round actually is — "already
    // running" is baffling when the window in front of you is idle.
    await expect(viaLink.locator('.agent-bar')).toContainText(/already running/i, {
      timeout: 20_000,
    });
    await expect(viaLink.locator('.agent-bar')).toContainText(path.basename(real));

    // The refusal cost nothing: one round happened, not two, and the
    // counter did not move twice.
    await expect(viaReal.getByText(/round 1 returned/i)).toBeVisible({ timeout: 60_000 });
    expect(sidecarOf(real).round).toBe(1);
    // One turn's worth of output, not two.
    expect(sidecarOf(real).suggestions.length).toBe(1);
  });

  test('two windows on different documents both run', async () => {
    // Scenario 13. The lock is the document's, not the project's — this
    // is the case a too-broad lock would break.
    m = await launch();
    const alpha = projectDoc(m.dir, 'proj/alpha.md', DOC);
    const beta = projectDoc(m.dir, 'proj/beta.md', DOC);

    const one = await openInNewWindow(m, alpha);
    // Two windows on *one* project. `openPath` would not produce this —
    // a window is scoped to a project, so asking for a second document
    // from an open project switches that window rather than starting a
    // rival one. `openInWindow` is the explorer's route and targets the
    // window it is called on, which is how the arrangement is made.
    await m.first.evaluate(() => window.margin.newWindow());
    await expect.poll(() => m.app.windows().filter((p) => p.url().includes('index.html')).length)
      .toBeGreaterThan(1);
    const fresh = m.app.windows().filter((p) => p.url().includes('index.html')).pop()!;
    await fresh.evaluate((f) => window.margin.openInWindow(f), beta);
    const two = await windowFor(m.app, beta);
    expect(two).not.toBe(one);

    await submit(one);
    await submit(two);

    // Both spend a round; neither blocks the other.
    await expect.poll(() => sidecarOf(alpha)?.round, { timeout: 60_000 }).toBe(1);
    await expect.poll(() => sidecarOf(beta)?.round, { timeout: 60_000 }).toBe(1);
    await expect.poll(() => sidecarOf(alpha)?.suggestions?.length, { timeout: 60_000 }).toBe(1);
    await expect.poll(() => sidecarOf(beta)?.suggestions?.length, { timeout: 60_000 }).toBe(1);
  });
});
