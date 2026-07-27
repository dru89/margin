import { test, expect } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

/**
 * A round that fails leaves the author where they were (#79, #106).
 *
 * The damage this replaces: the round counter moved before the turn ran
 * and stayed moved, so every draft the author had written read as
 * "awaiting reply" against a turn that never answered. Their queued
 * discussion messages had been marked sent and could not be sent again
 * without retyping. And submitting a second time moved the counter
 * *again*, stacking empty rounds behind the real ones.
 *
 * A round that produced nothing did not happen. Putting it back is what
 * makes Retry mean the same thing as Submit.
 */
const DOC = '# Plan\n\nThe first paragraph is long enough to attract an edit from the agent.\n';

/** Like `launch()` in margin.ts, but the fake agent fails with `error`. */
async function launchFailing(error: string) {
  const dir = mkdtempSync(path.join(tmpdir(), 'margin-fail-'));
  const userData = path.join(dir, 'userData');
  const projectsDir = path.join(dir, 'projects');
  mkdirSync(userData, { recursive: true });
  mkdirSync(projectsDir, { recursive: true });
  writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ projectsDir }, null, 2));
  const app: ElectronApplication = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    env: { ...process.env, MARGIN_FAKE_AGENT: `fail:${error}` },
  });
  const page: Page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return {
    app,
    page,
    dir,
    async close() {
      await app.close().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const read = (file: string) => {
  try {
    return JSON.parse(readFileSync(`${file}.review.json`, 'utf8'));
  } catch {
    return null;
  }
};
const discussionOf = (dir: string) => {
  try {
    return JSON.parse(readFileSync(path.join(dir, 'p', '.margin', 'discussion.json'), 'utf8'));
  } catch {
    return null;
  }
};

async function seed(m: Awaited<ReturnType<typeof launchFailing>>) {
  const file = path.join(m.dir, 'p', 'plan.md');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, DOC);
  await m.page.evaluate((f) => window.margin.openPath(f), file);
  await expect.poll(() => m.page.evaluate(() => !!document.querySelector('.cm-content'))).toBe(true);
  return file;
}

test.describe('a round that fails', () => {
  let m: Awaited<ReturnType<typeof launchFailing>>;
  test.afterEach(async () => m?.close());

  test('is put back so it can simply be sent again', async () => {
    m = await launchFailing('Failed to authenticate: OAuth session expired and could not be refreshed');
    const file = await seed(m);

    // Something to lose: a queued discussion message.
    await m.page.locator('.dock-composer textarea').fill('Focus on the rollout section.');
    await m.page.getByRole('button', { name: 'Queue', exact: true }).click();
    await expect.poll(() => discussionOf(m.dir)?.messages?.length).toBe(1);
    expect(discussionOf(m.dir).messages[0].pending).toBe(true);

    await m.page.getByRole('button', { name: /submit for review/i }).click();
    await m.page.getByRole('button', { name: /send round/i }).click();

    // The author is told what happened in their own terms, and what to do.
    await expect(m.page.getByText(/Claude login has expired/i)).toBeVisible({ timeout: 60_000 });
    await expect(m.page.getByText(/claude \/login/)).toBeVisible();

    // Nothing was spent: the counter is back at zero and the message is
    // queued again, ready to ride along with the next attempt.
    await expect.poll(() => read(file)?.round).toBe(0);
    await expect.poll(() => discussionOf(m.dir)?.messages?.[0]?.pending).toBe(true);
    expect(discussionOf(m.dir).messages).toHaveLength(1); // not duplicated

    // Retry is offered, because sending it again means exactly what
    // sending it the first time meant.
    await expect(m.page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  });

  test('retrying does not stack another empty round', async () => {
    // The old behaviour: every failed submit moved the counter, so two
    // failures left round 2 with nothing behind either of them.
    m = await launchFailing('fetch failed');
    const file = await seed(m);

    await m.page.getByRole('button', { name: /submit for review/i }).click();
    await m.page.getByRole('button', { name: /send round/i }).click();
    await expect(m.page.getByText(/could not reach Claude/i)).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => read(file)?.round).toBe(0);

    // Through the button the author would actually reach for. It fails the
    // same way — which is the case that used to be *invisible*, because
    // the bar dismissed by message text and this message was identical.
    await m.page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(m.page.getByText(/could not reach Claude/i)).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => read(file)?.round).toBe(0);
    await expect(m.page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  });

  test('losing the network says so, rather than blaming the login', async () => {
    // Both causes are named in the error a dropped refresh produces; only
    // one of them is something the author can see and act on.
    m = await launchFailing('Failed to authenticate: getaddrinfo EAI_AGAIN api.anthropic.com');
    await seed(m);

    await m.page.getByRole('button', { name: /submit for review/i }).click();
    await m.page.getByRole('button', { name: /send round/i }).click();

    await expect(m.page.getByText(/could not reach Claude/i)).toBeVisible({ timeout: 60_000 });
    await expect(m.page.getByText(/login has expired/i)).toHaveCount(0);
  });
});

test.describe('a round that succeeds', () => {
  test('still spends the round and the queued message', async () => {
    // The mirror of the above: a rollback must not fire when the turn
    // worked, or a real round would be silently un-counted.
    const m = await launchFailing('');
    await m.close();

    const dir = mkdtempSync(path.join(tmpdir(), 'margin-ok-'));
    const userData = path.join(dir, 'userData');
    mkdirSync(userData, { recursive: true });
    writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ projectsDir: dir }, null, 2));
    const app = await electron.launch({
      args: ['.', `--user-data-dir=${userData}`],
      env: { ...process.env, MARGIN_FAKE_AGENT: '1' },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    const file = path.join(dir, 'p', 'plan.md');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, DOC);
    await page.evaluate((f) => window.margin.openPath(f), file);
    await expect.poll(() => page.evaluate(() => !!document.querySelector('.cm-content'))).toBe(true);

    await page.locator('.dock-composer textarea').fill('Focus on the rollout section.');
    await page.getByRole('button', { name: 'Queue', exact: true }).click();
    await page.getByRole('button', { name: /submit for review/i }).click();
    await page.getByRole('button', { name: /send round/i }).click();

    await expect.poll(() => read(file)?.round, { timeout: 60_000 }).toBe(1);
    await expect.poll(() => discussionOf(dir)?.messages?.[0]?.pending, { timeout: 60_000 }).toBeFalsy();

    await app.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });
});
