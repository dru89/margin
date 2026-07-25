import { test, expect } from '@playwright/test';
import { launch, doc, windows, waitForWindows, showing, pageShowing, type Margin } from './margin';

/**
 * Journey 2 — window routing (#136, DECISIONS §62).
 *
 * A window is replaced when it holds nothing the author would lose, and a
 * new one opens when it does. Three regressions have already landed here
 * (#82, #119, and project creation stranding its setup window), which is
 * why it earns a journey rather than a unit test: every one of them was a
 * disagreement *between* the session registry, the window lifecycle and
 * the renderer, not a bug inside any of them.
 *
 * Assertions are on which window holds what, never on markup.
 */
test.describe('window routing', () => {
  let m: Margin;
  test.afterEach(async () => m?.close());

  test('opening from Welcome replaces that window', async () => {
    m = await launch();
    const alpha = doc(m.dir, 'proj/alpha.md', '# Alpha\n\nFirst.\n');
    expect(await windows(m.app)).toEqual(['welcome']);

    await m.first.evaluate((f) => window.margin.openPath(f), alpha);

    expect(await waitForWindows(m.app, 1)).toEqual(['alpha.md']);
  });

  test('opening a second document from an editor gets its own window', async () => {
    m = await launch();
    const alpha = doc(m.dir, 'proj/alpha.md', '# Alpha\n\nFirst.\n');
    const other = doc(m.dir, 'other/other.md', '# Other\n\nElsewhere.\n');
    await m.first.evaluate((f) => window.margin.openPath(f), alpha);
    await waitForWindows(m.app, 1);
    await m.first.evaluate((f) => window.margin.openPath(f), other);

    expect((await waitForWindows(m.app, 2)).sort()).toEqual(['alpha.md', 'other.md']);
  });

  test('a document from the same project reuses its window', async () => {
    // A window is scoped to a project, not a file: a second document from a
    // project already open switches that window rather than starting a rival
    // one over the same .margin/.
    m = await launch();
    const alpha = doc(m.dir, 'proj/alpha.md', '# Alpha\n\nFirst.\n');
    const beta = doc(m.dir, 'proj/beta.md', '# Beta\n\nSecond.\n');

    await m.first.evaluate((f) => window.margin.openPath(f), alpha);
    await waitForWindows(m.app, 1);
    await m.first.evaluate((f) => window.margin.openPath(f), beta);

    expect(await waitForWindows(m.app, 1)).toEqual(['beta.md']);
  });

  test('reopening an already-open document does not duplicate it', async () => {
    m = await launch();
    const alpha = doc(m.dir, 'proj/alpha.md', '# Alpha\n\nFirst.\n');
    const other = doc(m.dir, 'other/other.md', '# Other\n\nElsewhere.\n');

    await m.first.evaluate((f) => window.margin.openPath(f), alpha);
    await waitForWindows(m.app, 1);
    await m.first.evaluate((f) => window.margin.openPath(f), other);
    await waitForWindows(m.app, 2);

    // Ask for alpha again from the other window.
    const otherWin = await pageShowing(m.app, 'other.md');
    await otherWin!.evaluate((f) => window.margin.openPath(f), alpha);

    expect((await waitForWindows(m.app, 2)).sort()).toEqual(['alpha.md', 'other.md']);
  });

  test('the new-project screen is never replaced by an open', async () => {
    // It is a destination the author navigated to, not a landing screen —
    // even before anything has been typed into it (#82, #119).
    m = await launch();
    const alpha = doc(m.dir, 'proj/alpha.md', '# Alpha\n\nFirst.\n');
    const w = m.first;
    await w.getByRole('button', { name: /start a new project/i }).click();
    await expect.poll(() => showing(w)).toBe('new project');

    await w.evaluate((f) => window.margin.openPath(f), alpha);

    expect((await waitForWindows(m.app, 2)).sort()).toEqual(['alpha.md', 'new project']);
  });
});
