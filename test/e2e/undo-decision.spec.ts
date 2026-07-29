import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { launch, projectDoc, type Margin } from './margin';

/**
 * Accepting a suggestion is a decision, not a text edit (#128).
 *
 * It is recorded in two places — the document and the sidecar — and only
 * one of them used to be undoable, so Cmd-Z reverted the text while the
 * review went on claiming the edit had landed. The card was no longer
 * pending, so there was no way back.
 *
 * A slice of journey 1 (#134), kept separate so it lands with its fix
 * rather than waiting for the redesign.
 */
const DOC = '# Doc\n\nThe quick brown fox jumps over the lazy dog.\n';

/** Run a fake round so there is a real suggestion to decide on. */
async function roundWithSuggestion(m: Margin, file: string) {
  await m.first.evaluate((f) => window.margin.openPath(f), file);
  await expect.poll(() => m.first.evaluate(() => !!document.querySelector('.cm-content'))).toBe(true);
  await m.first.getByRole('button', { name: /submit for review/i }).click();
  await m.first.getByRole('button', { name: /send round/i }).click();
  await expect(m.first.locator('.card-suggestion, .card')).not.toHaveCount(0);
  // The sidebar's Accept, not the inline pill — the pill sits inside the
  // editor where a cm-line can intercept the click.
  await expect(m.first.locator('.card-suggestion').first()
    .getByRole('button', { name: 'Accept', exact: true }))
    .toBeVisible({ timeout: 60_000 });
}

const sidecarOf = (file: string) => {
  try {
    return JSON.parse(readFileSync(`${file}.review.json`, 'utf8'));
  } catch {
    return null;
  }
};

test.describe('deciding on a suggestion', () => {
  let m: Margin;
  test.afterEach(async () => m?.close());

  test('undo after accepting keeps the document and the review together', async () => {
    m = await launch();
    const file = projectDoc(m.dir, 'p/doc.md', DOC);
    await roundWithSuggestion(m, file);

    await m.first.locator('.card-suggestion').first()
      .getByRole('button', { name: 'Accept', exact: true }).click();
    await expect.poll(() => sidecarOf(file)?.suggestions[0]?.status).toBe('accepted');
    const accepted = readFileSync(file, 'utf8');
    expect(accepted).not.toBe(DOC);

    // Cmd-Z used to revert the text and leave the review saying 'accepted'.
    await m.first.locator('.cm-content').click();
    await m.first.keyboard.press('ControlOrMeta+z');
    await m.first.waitForTimeout(1200);

    const status = sidecarOf(file)?.suggestions[0]?.status;
    const text = readFileSync(file, 'utf8');
    // Whatever undo does, the two must agree: accepted text stays with an
    // accepted status, reverted text with a pending one.
    expect(status === 'accepted' ? text : DOC).toBe(text === DOC ? DOC : accepted);
    expect({ status, reverted: text === DOC }).toEqual({ status: 'accepted', reverted: false });
  });

  test('Undo on a decided suggestion restores the text and reopens it', async () => {
    m = await launch();
    const file = projectDoc(m.dir, 'p/doc.md', DOC);
    await roundWithSuggestion(m, file);

    await m.first.locator('.card-suggestion').first()
      .getByRole('button', { name: 'Accept', exact: true }).click();
    await expect.poll(() => sidecarOf(file)?.suggestions[0]?.status).toBe('accepted');
    expect(readFileSync(file, 'utf8')).not.toBe(DOC);

    await m.first.getByRole('button', { name: /resolved & decided/i }).click();
    await m.first.getByRole('button', { name: 'Undo', exact: true }).first().click();

    await expect.poll(() => sidecarOf(file)?.suggestions[0]?.status).toBe('pending');
    await expect.poll(() => readFileSync(file, 'utf8')).toBe(DOC);
  });

  test('Undo still works after the author keeps writing', async () => {
    // The applied range is remapped with every edit, so a decision does not
    // become unundoable just because the document moved on.
    m = await launch();
    const file = projectDoc(m.dir, 'p/doc.md', DOC);
    await roundWithSuggestion(m, file);
    await m.first.locator('.card-suggestion').first()
      .getByRole('button', { name: 'Accept', exact: true }).click();
    await expect.poll(() => sidecarOf(file)?.suggestions[0]?.status).toBe('accepted');

    // Type a new first paragraph, shifting everything below it.
    await m.first.locator('.cm-line').first().click();
    await m.first.keyboard.press('Home');
    await m.first.keyboard.type('Inserted above.\n\n');
    await m.first.waitForTimeout(1200);

    await m.first.getByRole('button', { name: /resolved & decided/i }).click();
    await m.first.getByRole('button', { name: 'Undo', exact: true }).first().click();

    await expect.poll(() => sidecarOf(file)?.suggestions[0]?.status).toBe('pending');
    await expect.poll(() => readFileSync(file, 'utf8')).toContain('over the lazy dog.');
    expect(readFileSync(file, 'utf8')).toContain('Inserted above.');
  });
});
