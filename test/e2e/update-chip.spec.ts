import { test, expect } from '@playwright/test';
import { launch, projectDoc, type Margin } from './margin';

/**
 * The update affordance (#180).
 *
 * The decision under test: **the dialog is an interruption and the chip
 * is a status.** Margin now re-checks for updates on a timer, and the
 * thing that must never follow is a modal opening over someone's
 * writing — so the timer moves the chip and nothing else. Deferring
 * silences the prompt without hiding that an update exists; skipping the
 * version, which is a decision about the release rather than about this
 * moment, takes the chip away too.
 *
 * `MARGIN_FAKE_UPDATE` stands in for a release: a dev build has no feed,
 * and this exercises everything downstream of "an update was found".
 */

const DOC = '# Plan\n\nA paragraph long enough to look like a document.\n';

/** Answer the native dialog with a button index, and record that it opened. */
async function stubDialog(m: Margin, response: number) {
  await m.app.evaluate(({ dialog }, response) => {
    const g = globalThis as unknown as { __dialogs: string[] };
    g.__dialogs = [];
    dialog.showMessageBox = async (...args: unknown[]) => {
      const options = (args.length > 1 ? args[1] : args[0]) as { message?: string };
      g.__dialogs.push(options?.message ?? '');
      return { response, checkboxChecked: false };
    };
  }, response);
}

const dialogsSeen = (m: Margin): Promise<string[]> =>
  m.app.evaluate(() => (globalThis as unknown as { __dialogs?: string[] }).__dialogs ?? []);

const chip = (m: Margin) => m.first.locator('.update-chip');

test.describe('the update chip', () => {
  let m: Margin;
  test.afterEach(async () => m?.close());

  test('an available update waits in the toolbar instead of interrupting', async () => {
    m = await launch({ env: { MARGIN_FAKE_UPDATE: '0.6.0' } });
    await stubDialog(m, 1);
    const file = projectDoc(m.dir, 'p/plan.md', DOC);
    await m.first.evaluate((f) => window.margin.openPath(f), file);
    await expect.poll(() => m.first.evaluate(() => !!document.querySelector('.cm-content'))).toBe(true);

    await expect(chip(m)).toHaveText(/Update 0\.6\.0/);
    // The whole point: finding an update opened nothing.
    expect(await dialogsSeen(m)).toEqual([]);
    // And the editor is still the author's — no modal took the focus.
    await m.first.locator('.cm-line').first().click();
    await m.first.keyboard.press('End');
    await m.first.keyboard.type(' edited');
    await expect.poll(() => m.first.evaluate(() => document.querySelector('.cm-content')?.textContent))
      .toContain('# Plan edited');
  });

  test('clicking it is what opens the dialog', async () => {
    m = await launch({ env: { MARGIN_FAKE_UPDATE: '0.6.0' } });
    await stubDialog(m, 1); // "Remind Me Later"
    const file = projectDoc(m.dir, 'p/plan.md', DOC);
    await m.first.evaluate((f) => window.margin.openPath(f), file);
    await expect(chip(m)).toBeVisible();

    await chip(m).click();
    await expect.poll(() => dialogsSeen(m)).toEqual(['Update Available']);

    // Deferring silences the interruption and leaves the status alone —
    // the pair that lets a periodic check exist without nagging.
    await expect(chip(m)).toHaveText(/Update 0\.6\.0/);
  });

  test('skipping the version takes the chip away', async () => {
    m = await launch({ env: { MARGIN_FAKE_UPDATE: '0.6.0' } });
    await stubDialog(m, 2); // "Skip This Version"
    const file = projectDoc(m.dir, 'p/plan.md', DOC);
    await m.first.evaluate((f) => window.margin.openPath(f), file);
    await expect(chip(m)).toBeVisible();

    await chip(m).click();
    // A decision about the release, not about this moment.
    await expect(chip(m)).toHaveCount(0);
  });

  test('a downloaded update keeps saying so after the restart is declined', async () => {
    // The state that had no surface at all before: "Later" left the
    // update on disk with nothing to say it was there, and the app
    // running the old version indefinitely.
    m = await launch({ env: { MARGIN_FAKE_UPDATE: '0.6.0' } });
    await stubDialog(m, 0); // "Install Update", then "Restart Now"…
    const file = projectDoc(m.dir, 'p/plan.md', DOC);
    await m.first.evaluate((f) => window.margin.openPath(f), file);
    await expect(chip(m)).toBeVisible();

    // …but answer the *second* dialog with "Later" instead.
    await chip(m).click();
    await stubDialog(m, 1);
    await expect(chip(m)).toHaveText(/Restart to update/, { timeout: 20_000 });
    await expect(chip(m)).toBeEnabled();
  });

  test('a window with no document still shows it', async () => {
    // A long-idle window is often sitting on Welcome, which has no
    // toolbar to hang the chip from.
    m = await launch({ env: { MARGIN_FAKE_UPDATE: '0.6.0' } });
    await expect(m.first.locator('.welcome-update .update-chip')).toHaveText(/Update 0\.6\.0/);
  });
});
