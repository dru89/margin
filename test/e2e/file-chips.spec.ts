import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { launch, doc, showing, type Margin } from './margin';

/**
 * `@path` references in comment text (spec §9, #90).
 *
 * The rule being asserted is where a reference can point and what
 * clicking one does. A chip resolves against the project's own file list,
 * so a reference to anything outside the project names nothing and is
 * inert — which matters because the agent writes comment text, and a
 * clickable reference reaches the disk.
 */
const DOC = '# Doc\n\nThe quick brown fox jumps over the lazy dog.\n';

function seed(dir: string, commentText: string): string {
  const file = doc(dir, 'p/doc.md', DOC);
  const root = path.dirname(file);
  writeFileSync(path.join(root, 'notes.md'), '# Notes\n\nSecond document.\n');
  mkdirSync(path.join(root, 'data'), { recursive: true });
  writeFileSync(path.join(root, 'data', 'rotations.csv'), 'week,who\n1,alex\n');
  // Outside the project entirely — the thing a reference must not reach.
  writeFileSync(path.join(dir, 'outside.md'), '# Not yours\n');
  writeFileSync(`${file}.review.json`, JSON.stringify({
    version: 1, document: 'doc.md', round: 1,
    comments: [{
      id: 'c1', author: 'agent', round: 1, createdAt: '2026-07-20T00:00:00Z',
      text: commentText,
      anchor: { from: DOC.indexOf('quick'), to: DOC.indexOf('quick') + 5, quote: 'quick' },
      replies: [], status: 'open',
    }],
    suggestions: [], discussion: [],
  }, null, 2));
  return file;
}

const open = async (m: Margin, file: string) => {
  await m.first.evaluate((f) => window.margin.openPath(f), file);
  await expect(m.first.locator('.card-comment')).toBeVisible();
};

test.describe('@path file references', () => {
  let m: Margin;
  test.afterEach(async () => m?.close());

  test('a reference to a markdown file opens it in Margin', async () => {
    m = await launch();
    const file = seed(m.dir, 'Compare against @notes.md before deciding.');
    await open(m, file);

    await m.first.getByRole('button', { name: '@notes.md' }).click();
    await expect.poll(() => showing(m.first)).toBe('notes.md');
  });

  test('a reference to a file that is not markdown opens in its default app', async () => {
    // Margin only edits markdown, so anything else goes where the desktop
    // sends it — the same rule the file explorer follows.
    m = await launch();
    const file = seed(m.dir, 'The evidence is in @data/rotations.csv, row 2.');
    await open(m, file);

    await m.app.evaluate(({ shell }) => {
      (globalThis as Record<string, unknown>).__opened = [];
      shell.openPath = async (p: string) => {
        ((globalThis as Record<string, unknown>).__opened as string[]).push(p);
        return '';
      };
    });
    await m.first.getByRole('button', { name: '@data/rotations.csv' }).click();

    await expect
      .poll(() =>
        m.app.evaluate(() =>
          ((globalThis as Record<string, unknown>).__opened as string[]).map((p) =>
            p.split(/[/\\]/).slice(-2).join('/'),
          ),
        ),
      )
      .toEqual(['data/rotations.csv']);
    // The window stayed on the document; only markdown opens in Margin.
    expect(await showing(m.first)).toBe('doc.md');
  });

  test('a reference outside the project names nothing and is inert', async () => {
    // The agent writes comment text. Traversal out of the project must not
    // produce something the author can click.
    m = await launch();
    const file = seed(m.dir, 'See @../outside.md and @/etc/hostname for context.');
    await open(m, file);

    await expect(m.first.getByRole('button', { name: /outside\.md/ })).toHaveCount(0);
    await expect(m.first.getByRole('button', { name: /hostname/ })).toHaveCount(0);
    // Still shown as written — the text is never rewritten, only rendered.
    await expect(m.first.locator('.card-comment')).toContainText('@../outside.md');
  });

  test('main refuses to open a path outside the project', async () => {
    // The renderer already declines to make that chip clickable; this is
    // the boundary that actually reaches the disk, checked independently.
    m = await launch();
    const file = seed(m.dir, 'nothing to see');
    await open(m, file);
    const outside = path.join(m.dir, 'outside.md');

    const result = await m.first.evaluate(
      (p) => window.margin.openExternal(p).then(() => 'opened').catch((e) => String(e)),
      outside,
    );
    expect(result).toContain('not in this project');
  });
});
