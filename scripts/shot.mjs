#!/usr/bin/env node
/**
 * Screenshot the built app, in both themes, without taking the screen.
 *
 * Electron has no headless mode, so run this under `xvfb-run` — the app
 * then maps its window on a display nobody is attached to. Nothing is
 * lost by doing so: fonts and layout resolve identically, and
 * `--force-device-scale-factor` makes the capture sharper than a real
 * fractional-scaled display.
 *
 *   xvfb-run -a -s "-screen 0 1920x1080x24" \
 *     node scripts/shot.mjs --file .fixtures/review-surface/self-evaluation.md --name surface
 *
 * Options:
 *   --file <path>      markdown to open (default: the Welcome screen)
 *   --name <prefix>    output basename; files are <name>-{light,dark}.png
 *   --out <dir>        where to write (default: .fixtures/shots)
 *   --selector <css>   capture just this element instead of the window
 *   --scale <n>        device scale factor (default: 2)
 *   --wait <ms>        settle time before capturing (default: 500)
 *
 * Drives Playwright rather than a backgrounded `npx electron`, because
 * Playwright passes `env` explicitly — some agent harnesses scrub the
 * environment of detached processes, which silently drops
 * MARGIN_FAKE_AGENT and friends.
 */
import { _electron as electron } from 'playwright';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const file = arg('file');
const name = arg('name', 'shot');
const outDir = path.resolve(arg('out', '.fixtures/shots'));
const selector = arg('selector');
const scale = arg('scale', '2');
const wait = Number(arg('wait', '500'));

mkdirSync(outDir, { recursive: true });

// An isolated userData, so a screenshot run never touches real settings
// or recents — the same bargain the journey harness makes.
const scratch = mkdtempSync(path.join(tmpdir(), 'margin-shot-'));
const userData = path.join(scratch, 'userData');
mkdirSync(userData, { recursive: true });
writeFileSync(
  path.join(userData, 'settings.json'),
  JSON.stringify({ projectsDir: path.join(scratch, 'projects') }, null, 2),
);

const app = await electron.launch({
  args: ['.', `--user-data-dir=${userData}`, `--force-device-scale-factor=${scale}`],
  env: { ...process.env, MARGIN_FAKE_AGENT: process.env.MARGIN_FAKE_AGENT ?? '1' },
});
const page = await app.firstWindow();
await page.waitForLoadState('domcontentloaded');

if (file) {
  const abs = path.resolve(file);
  await page.evaluate((f) => window.margin.openPath(f), abs);
  await page.waitForSelector('.cm-content', { timeout: 30_000 });
}
if (selector) await page.waitForSelector(selector, { timeout: 30_000 });

for (const theme of ['light', 'dark']) {
  await page.emulateMedia({ colorScheme: theme });
  await page.waitForTimeout(wait);
  const target = selector ? await page.$(selector) : page;
  const out = path.join(outDir, `${name}-${theme}.png`);
  await target.screenshot({ path: out });
  console.log(out);
}

await app.close();
