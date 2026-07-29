import { test, expect } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { launch, doc, type Margin } from './margin';

/**
 * Adopting a folder (spec §1, §4, §5 — issue #169).
 *
 * **A project is declared, never derived.** These cover the two ways a
 * declaration happens — opening a folder, and being asked when an action
 * needs one — and the state in between, whose entire job is to write
 * nothing.
 *
 * Spec scenarios 1, 2, 4 and 5. Scenario 4 is the headline: a document
 * under no declaration must leave no trace in its folder, because a
 * `.margin/` written there is exactly what a later walk reads back as a
 * project. That is the accident this spec removes, arriving by a
 * different door.
 */

const DOC = [
  '# Rollout plan',
  '',
  'The first paragraph is long enough to attract a suggested edit from the agent.',
  '',
  'The second paragraph mentions the staging window and is where the comment goes.',
  '',
].join('\n');

const QUOTE = 'the staging window';

const sidecarOf = (file: string) => {
  try {
    return JSON.parse(readFileSync(`${file}.review.json`, 'utf8'));
  } catch {
    return null;
  }
};

/**
 * Select `quote` by counting from the start of the document — clicking a
 * line and pressing Home lands on a *visual* row when the line wraps, and
 * leaves no selection at all.
 */
async function selectQuote(m: Margin, source: string, quote: string) {
  const at = source.indexOf(quote);
  if (at < 0) throw new Error(`quote not in the document: ${quote}`);
  await m.first.locator('.cm-content').click();
  await m.first.keyboard.press('ControlOrMeta+Home');
  for (let i = 0; i < at; i++) await m.first.keyboard.press('ArrowRight');
  for (let i = 0; i < quote.length; i++) await m.first.keyboard.press('Shift+ArrowRight');
}

async function comment(m: Margin, text: string) {
  await m.first.getByRole('button', { name: /\+ comment/i }).click();
  await m.first.locator('.card-composer textarea').first().fill(text);
  await m.first.locator('.card-composer .card-actions')
    .getByRole('button', { name: 'Comment', exact: true }).click();
}

/** What the open document says about its project. */
const projectOf = (m: Margin) =>
  m.first.evaluate(async () => {
    const d = await window.margin.getDoc();
    return d ? { root: d.workspaceRoot, hasProject: d.hasProject } : null;
  });

/** Answer the native folder picker and the adoption confirmation. */
async function stubDialogs(m: Margin, folder: string, confirm = true) {
  await m.app.evaluate(
    ({ dialog }, { folder, confirm }) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
      dialog.showMessageBox = async () => ({ response: confirm ? 0 : 1, checkboxChecked: false });
    },
    { folder, confirm },
  );
}

test.describe('adoption', () => {
  let m: Margin;
  test.afterEach(async () => m?.close());

  test('a document under no declaration writes nothing to its folder', async () => {
    // Scenario 4. Reviewing your own writing is free: the sidecar is a
    // sibling of the document, so comments, suggestions and anchors all
    // work with no project at all.
    m = await launch();
    const folder = path.join(m.dir, 'loose');
    const file = doc(m.dir, 'loose/notes.md', DOC);
    await m.first.evaluate((f) => window.margin.openPath(f), file);
    await expect.poll(() => m.first.evaluate(() => !!document.querySelector('.cm-content'))).toBe(true);

    expect(await projectOf(m)).toEqual({ root: folder, hasProject: false });

    await selectQuote(m, DOC, QUOTE);
    await comment(m, 'Does this survive without a project?');
    await expect.poll(() => sidecarOf(file)?.comments?.length).toBe(1);

    // Type into the document too — autosave is the other routine writer.
    await m.first.locator('.cm-line').first().click();
    await m.first.keyboard.press('End');
    await m.first.keyboard.type(' v2');
    await expect.poll(() => readFileSync(file, 'utf8').includes('# Rollout plan v2')).toBe(true);

    // The assertion the whole spec is for.
    expect(existsSync(path.join(folder, 'margin.json'))).toBe(false);
    expect(existsSync(path.join(folder, '.margin'))).toBe(false);
    expect(existsSync(path.join(m.dir, '.margin'))).toBe(false);

    // And the affordances that would have written there are unavailable
    // rather than inert — queueing a message that then vanishes would be
    // worse than the accident.
    await expect(m.first.locator('.dock-no-project')).toBeVisible();
    await expect(m.first.locator('.dock-composer textarea')).toHaveCount(0);
    await expect(m.first.getByRole('button', { name: /not a project/i })).toBeVisible();

    // The renderer hiding the composer is presentation. The refusal has
    // to live where the write does, so ask main directly.
    const refusals = await m.first.evaluate(async () => {
      const fail = (p: Promise<unknown>) => p.then(() => 'wrote it', (e: Error) => e.message);
      return {
        discussion: await fail(
          window.margin.updateDiscussion([
            { id: 'x', author: 'user', text: 'hi', createdAt: new Date().toISOString(), pending: true },
          ]),
        ),
        round: await fail(window.margin.gdocsShareCreate().then((r) => (r.error ? Promise.reject(new Error(r.error)) : r))),
      };
    });
    expect(refusals.discussion).toMatch(/needs a project/i);
    expect(refusals.round).toMatch(/needs a project/i);
    expect(existsSync(path.join(folder, '.margin'))).toBe(false);
  });

  test('a round asks for a folder, and picks up the comment made before it', async () => {
    // Scenarios 2 and 5. A round writes agent notes and can stage
    // proposals, so it is the moment the app asks — and the comment
    // written beforehand is pending, not wasted.
    m = await launch();
    const folder = path.join(m.dir, 'loose');
    const file = doc(m.dir, 'loose/notes.md', DOC);
    await m.first.evaluate((f) => window.margin.openPath(f), file);
    await expect.poll(() => m.first.evaluate(() => !!document.querySelector('.cm-content'))).toBe(true);

    await selectQuote(m, DOC, QUOTE);
    await comment(m, 'Written before there was a project.');
    await expect.poll(() => sidecarOf(file)?.comments?.length).toBe(1);

    await m.first.getByRole('button', { name: /submit for review/i }).click();
    await m.first.getByRole('button', { name: /send round/i }).click();

    // The prompt, not the round.
    await expect(m.first.getByRole('heading', { name: /which folder is this project/i })).toBeVisible();
    expect(sidecarOf(file).round).toBe(0);
    expect(existsSync(path.join(folder, 'margin.json'))).toBe(false);

    // The document's own folder is preselected, so confirming is one click.
    await m.first.getByRole('button', { name: /create project/i }).click();

    // Adopting writes the record — the act and the record are the same thing.
    await expect.poll(() => existsSync(path.join(folder, 'margin.json'))).toBe(true);
    expect(JSON.parse(readFileSync(path.join(folder, 'margin.json'), 'utf8'))).toMatchObject({ version: 1 });
    await expect.poll(() => projectOf(m)).toEqual({ root: folder, hasProject: true });

    // And carries straight on with what was asked for, rather than making
    // the author press Submit a second time.
    await expect.poll(() => sidecarOf(file)?.round, { timeout: 60_000 }).toBe(1);
    // Scenario 5: the comment made before adoption is what the round answers.
    await expect.poll(() => sidecarOf(file)?.comments?.[0]?.replies?.length, { timeout: 60_000 }).toBe(1);
    expect(sidecarOf(file).comments[0].replies[0]).toMatchObject({ author: 'agent', round: 1 });

    // The round's own project writes now have somewhere to go.
    await expect.poll(() => existsSync(path.join(folder, '.margin')), { timeout: 60_000 }).toBe(true);
  });

  test('cancelling the prompt leaves the folder untouched', async () => {
    // The prompt is a question, and "no" has to mean no — including not
    // spending the round it was asked for.
    m = await launch();
    const folder = path.join(m.dir, 'loose');
    const file = doc(m.dir, 'loose/notes.md', DOC);
    await m.first.evaluate((f) => window.margin.openPath(f), file);
    await expect.poll(() => m.first.evaluate(() => !!document.querySelector('.cm-content'))).toBe(true);

    await m.first.getByRole('button', { name: /submit for review/i }).click();
    await m.first.getByRole('button', { name: /send round/i }).click();
    await expect(m.first.getByRole('heading', { name: /which folder is this project/i })).toBeVisible();
    await m.first.locator('.adopt-modal').getByRole('button', { name: 'Cancel', exact: true }).click();

    await expect(m.first.locator('.adopt-modal')).toHaveCount(0);
    expect(existsSync(path.join(folder, 'margin.json'))).toBe(false);
    expect(existsSync(path.join(folder, '.margin'))).toBe(false);
    expect(await projectOf(m)).toEqual({ root: folder, hasProject: false });
    expect(sidecarOf(file)?.round ?? 0).toBe(0);
  });

  test('opening a folder that declares itself adopts it, name and all', async () => {
    // Scenario 1. The project's name comes from `margin.json`, which is
    // the reason the field exists — until now a project could only be
    // called whatever its directory was called.
    m = await launch();
    const folder = path.join(m.dir, 'book');
    doc(m.dir, 'book/chapter.md', DOC);
    writeFileSync(
      path.join(folder, 'margin.json'),
      JSON.stringify({ version: 1, name: 'The Long Book' }),
    );

    await stubDialogs(m, folder);
    await m.first.evaluate(() => window.margin.openFolderDialog());
    await expect.poll(() => projectOf(m), { timeout: 15_000 })
      .toEqual({ root: folder, hasProject: true });
    await expect(m.first.locator('.explorer-root-name')).toHaveText('The Long Book');
    // Nothing was asked and nothing was rewritten: it already said what it is.
    expect(JSON.parse(readFileSync(path.join(folder, 'margin.json'), 'utf8')).name)
      .toBe('The Long Book');
  });

  test('opening an undeclared folder asks first, then writes margin.json there', async () => {
    // Scenario 2, by the other route. Confirming is what puts a file into
    // somebody's folder, so it is the one thing that gets a question.
    m = await launch();
    const folder = path.join(m.dir, 'writing');
    doc(m.dir, 'writing/draft.md', DOC);

    await stubDialogs(m, folder, false); // declined
    await m.first.evaluate(() => window.margin.openFolderDialog());
    await m.first.waitForTimeout(500);
    expect(existsSync(path.join(folder, 'margin.json'))).toBe(false);
    expect(await m.first.evaluate(() => window.margin.getDoc().then((d) => d?.filePath ?? null)))
      .toBe(null);

    await stubDialogs(m, folder, true); // accepted
    await m.first.evaluate(() => window.margin.openFolderDialog());
    await expect.poll(() => existsSync(path.join(folder, 'margin.json')), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => projectOf(m)).toEqual({ root: folder, hasProject: true });
  });

  test('a window keeps the project it was opened as', async () => {
    // Drew's `book/` + `book/chapter1/` case (spec §1, §6). Browsing to a
    // document inside a *nested* project must not silently re-root the
    // window on it — that would swap the discussion, the agent notes and
    // the model preference without saying so. Under a plain walk up from
    // the file, which is what resolution used to be, it would.
    m = await launch();
    const book = path.join(m.dir, 'book');
    const chapter1 = path.join(book, 'chapter1');
    mkdirSync(chapter1, { recursive: true });
    // Named so it sorts first: opening a folder seeds the window with the
    // *first* markdown file under it, and seeding with the nested one
    // would make the switch below a no-op — which is how this test passed
    // against a build that had the behaviour removed.
    doc(m.dir, 'book/a-preface.md', DOC);
    const inner = doc(m.dir, 'book/chapter1/one.md', DOC);
    writeFileSync(path.join(book, 'margin.json'), JSON.stringify({ version: 1, name: 'Book' }));
    writeFileSync(path.join(chapter1, 'margin.json'), JSON.stringify({ version: 1, name: 'Ch1' }));

    await stubDialogs(m, book);
    await m.first.evaluate(() => window.margin.openFolderDialog());
    await expect.poll(() => projectOf(m), { timeout: 15_000 })
      .toEqual({ root: book, hasProject: true });
    await expect.poll(() => m.first.evaluate(() => window.margin.getDoc().then((d) => d?.fileName)))
      .toBe('a-preface.md');

    // `book`'s explorer lists the nested document (scenario 10); opening
    // it is browsing within `book`.
    await m.first.evaluate((f) => window.margin.openInWindow(f), inner);
    await expect.poll(() => m.first.evaluate(() => window.margin.getDoc().then((d) => d?.fileName)))
      .toBe('one.md');
    expect(await projectOf(m)).toEqual({ root: book, hasProject: true });
    await expect(m.first.locator('.explorer-root-name')).toHaveText('Book');
  });
});
