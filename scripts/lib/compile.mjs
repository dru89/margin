import { execFileSync } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

/** Compile one TS module to ESM and import it. No framework; see CLAUDE.md. */
export async function load(entry) {
  const dir = mkdtempSync(path.join(tmpdir(), 'margin-test-'));
  const out = path.join(dir, 'mod.mjs');
  execFileSync(
    'npx',
    // Bundle dependencies in: the output lands in a temp dir with no
    // node_modules beside it. --platform=node keeps builtins external.
    // None of the modules under test import electron.
    ['esbuild', entry, '--bundle', '--format=esm', '--platform=node',
     '--alias:@shared=./src/shared', `--outfile=${out}`, '--log-level=error'],
    { stdio: 'inherit' },
  );
  return { mod: await import(pathToFileURL(out).href), dir };
}

export function reporter() {
  let fails = 0;
  return {
    t(label, got, want) {
      const ok = JSON.stringify(got) === JSON.stringify(want);
      if (!ok) fails++;
      console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(58)} ${JSON.stringify(got)}${ok ? '' : `   (want ${JSON.stringify(want)})`}`);
    },
    head: (s) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 56 - s.length))}`),
    done(name) {
      console.log(fails === 0 ? `\nAll ${name} cases pass.` : `\n${fails} FAILING`);
      process.exit(fails === 0 ? 0 : 1);
    },
  };
}
