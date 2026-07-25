import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { launch, doc, type Margin } from './margin';

/**
 * Journey 4 — the document surface (#136).
 *
 * Preview, the rendered→source quote mapping behind commenting from
 * preview, the table formatter as the user reaches it, and the link guard
 * from #99. Each crosses a seam a unit test can't reach: the markdown
 * pipeline, the editor bridge, and Electron's navigation handling.
 */
test.describe('the document surface', () => {
  let m: Margin;
  test.afterEach(async () => m?.close());

  test('preview renders the document', async () => {
    m = await launch();
    const file = doc(m.dir, 'p/doc.md', '# Title\n\nSome **bold** prose.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n');
    await m.first.evaluate((f) => window.margin.openPath(f), file);
    await expect.poll(() => m.first.evaluate(() => !!document.querySelector('.cm-content'))).toBe(true);

    await m.first.getByRole('button', { name: 'Preview', exact: true }).click();

    await expect(m.first.locator('.preview-body h1')).toHaveText('Title');
    await expect(m.first.locator('.preview-body strong')).toHaveText('bold');
    // The table survives the pipeline as a real table, not escaped text.
    await expect(m.first.locator('.preview-body table td').first()).toHaveText('1');
  });

  test('a comment made from preview anchors to the source text', async () => {
    // Rendered text has no source offsets, so the quote is re-located in the
    // markdown. This is the seam: a selection that crosses formatting can't
    // resolve, and a wrong resolution silently anchors to the wrong words.
    m = await launch();
    const file = doc(m.dir, 'p/doc.md', '# Title\n\nThe quick brown fox jumps over the lazy dog.\n');
    await m.first.evaluate((f) => window.margin.openPath(f), file);
    await expect.poll(() => m.first.evaluate(() => !!document.querySelector('.cm-content'))).toBe(true);
    await m.first.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(m.first.locator('.preview-body p')).toBeVisible();

    // Select "lazy dog" in the rendered paragraph.
    await m.first.evaluate(() => {
      const p = document.querySelector('.preview-body p')!;
      const node = p.firstChild!;
      const text = node.textContent!;
      const start = text.indexOf('lazy dog');
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + 'lazy dog'.length);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      // Preview captures the quote on mouseup, the way a drag-select ends.
      document.querySelector('.preview-body')!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await m.first.getByRole('button', { name: /\+ Comment/ }).click();
    await m.first.locator('.card-composer textarea').fill('from preview');
    await m.first.locator('.card-composer .card-actions .btn-primary').click();

    // The sidecar is the truth: the anchor must cover the source words.
    const sidecar = `${file}.review.json`;
    await expect
      .poll(() => {
        try {
          const r = JSON.parse(readFileSync(sidecar, 'utf8'));
          return r.comments[0]?.anchor?.quote;
        } catch {
          return undefined;
        }
      })
      .toBe('lazy dog');
  });

  test('formatting a table rewrites the file', async () => {
    m = await launch();
    const file = doc(m.dir, 'p/doc.md', '# T\n\n|a|bbbb|\n|---|---|\n|cccc|d|\n');
    await m.first.evaluate((f) => window.margin.openPath(f), file);
    await expect.poll(() => m.first.evaluate(() => !!document.querySelector('.cm-content'))).toBe(true);

    // Click the pill the editor offers on an unformatted table — the same
    // affordance a user reaches for.
    const line = m.first.locator('.cm-line', { hasText: 'cccc' });
    await line.click();
    await m.first.locator('[data-action="format-table"]').first().click();

    await expect
      .poll(() => readFileSync(file, 'utf8').includes('| a    | bbbb |'))
      .toBe(true);
  });

  test('an external link goes to the browser, not the window (#99)', async () => {
    // A plain <a href> used to navigate the whole window away from the app
    // with no way back. Two halves matter: the window stays put, and the URL
    // actually reaches the browser.
    m = await launch();
    const file = doc(m.dir, 'p/doc.md', '# T\n\nSee [the site](https://example.com/) for more.\n');
    await m.first.evaluate((f) => window.margin.openPath(f), file);
    await m.first.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(m.first.locator('.preview-body a')).toBeVisible();

    // Stub openExternal, or the test opens a real browser on every run.
    await m.app.evaluate(({ shell }) => {
      (globalThis as Record<string, unknown>).__opened = [];
      shell.openExternal = async (url: string) => {
        ((globalThis as Record<string, unknown>).__opened as string[]).push(url);
      };
    });
    const before = await m.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.getURL(),
    );

    // The navigation is deliberately prevented, so nothing completes — read
    // the outcome from the main process rather than waiting in the renderer.
    await m.first.locator('.preview-body a').click({ noWaitAfter: true });

    await expect
      .poll(() => m.app.evaluate(() => (globalThis as Record<string, unknown>).__opened as string[]))
      .toEqual(['https://example.com/']);
    const after = await m.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.getURL(),
    );
    expect(after).toBe(before);
  });
});
