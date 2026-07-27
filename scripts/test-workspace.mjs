#!/usr/bin/env node
/**
 * Finding the project a document belongs to (spec §3, #168).
 *
 * The rule replaced DECISIONS §63 wholesale: **find a declaration, never
 * invent one.** Every case below that used to assert a *derivation* — the
 * git toplevel, the file's own folder, and the precedence between them —
 * now asserts that no project is found, because inventing one is what
 * made sibling folders into separate projects by accident.
 *
 *   node scripts/test-workspace.mjs
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'fs';
import { tmpdir, homedir } from 'os';
import path from 'path';
import { load, reporter } from './lib/compile.mjs';

const { mod, dir: build } = await load('src/main/workspace.ts');
const { findProjectRoot, findWorkspaceRoot, resolveInsideWorkspace } = mod;
const { t, head, done } = reporter();

const base = mkdtempSync(path.join(tmpdir(), 'margin-roots-'));
const make = (rel, { git = false, marker = false } = {}) => {
  const abs = path.join(base, rel);
  mkdirSync(abs, { recursive: true });
  if (marker) mkdirSync(path.join(abs, '.margin'), { recursive: true });
  if (git) execFileSync('git', ['init', '-q'], { cwd: abs });
  return abs;
};
const doc = (dir, name = 'd.md') => {
  const p = path.join(dir, name);
  writeFileSync(p, '# doc\n');
  return p;
};
const rootOf = async (file) => path.relative(base, await findWorkspaceRoot(file)) || '.';

const marginJson = (dir) => {
  writeFileSync(path.join(dir, 'margin.json'), JSON.stringify({ version: 1 }));
  return dir;
};
const projectOf = async (file) => {
  const found = await findProjectRoot(file);
  return found === null ? null : path.relative(base, found) || '.';
};

head('a declaration is found');
t('margin.json in the file’s own folder', await projectOf(doc(marginJson(make('declared')))), 'declared');
t('margin.json above it', await projectOf(doc(make('above/sub'), 'n.md')) , null); // nothing declared yet
marginJson(make('above'));
t('...once the ancestor declares', await projectOf(doc(make('above/sub'), 'n.md')), 'above');
// Every project that exists today is this one.
t('a legacy .margin/ still declares', await projectOf(doc(make('legacy', { marker: true }))), 'legacy');

head('nothing is invented');
// These four replace the old precedence rules. Each used to resolve to
// something; a folder nobody declared is now simply not a project.
t('a plain folder', await projectOf(doc(make('plain'))), null);
t('a git repo with no declaration', await projectOf(doc(make('bare-repo', { git: true }))), null);
t('a file deep inside an undeclared repo',
  await projectOf(doc(make('bare-repo/docs/deep'), 'n.md')), null);
t('a sibling of a declared project is not in it',
  await projectOf(doc(make('declared-sibling'))), null);

head('the nearest declaration wins');
marginJson(make('outer2'));
marginJson(make('outer2/inner2'));
t('nested declarations are nested on purpose',
  await projectOf(doc(make('outer2/inner2'), 'n.md')), path.join('outer2', 'inner2'));
// The old "deeper of marker and git wins" rule is gone with derivation:
// a repo below a declaration is just a folder inside it.
marginJson(make('declared-parent'));
make('declared-parent/repo', { git: true });
t('a git repo below a declaration belongs to it',
  await projectOf(doc(make('declared-parent/repo'), 'n.md')), 'declared-parent');

head('guard: the home directory is refused');
// `~/.margin/` was created by accident under the old rules, and treating
// that leftover as a declaration would hand every file under home to one
// enormous project.
t('a file directly in home has no project',
  await findProjectRoot(path.join(homedir(), '__margin_probe_does_not_exist.md')), null);

head('the working root, until step 3 lands');
// findWorkspaceRoot still returns somewhere, because everything
// downstream assumes a root. The fallback is not a declaration.
t('a declared project', path.relative(base, await findWorkspaceRoot(doc(marginJson(make('wr-declared'))))), 'wr-declared');
t('an undeclared folder falls back to the document’s own',
  path.relative(base, await findWorkspaceRoot(doc(make('wr-plain')))), 'wr-plain');

head('opening a file: nothing outside the project (#90)');
// A chip's path comes from comment text and the agent writes comment
// text, so "open this in its default app" is an untrusted request now.
const openRoot = make('open-me');
const openDoc = doc(openRoot, 'notes.md');
mkdirSync(path.join(openRoot, 'sub'), { recursive: true });
doc(path.join(openRoot, 'sub'), 'deep.md');
const outsider = doc(make('not-mine'), 'secret.md');
const inside = async (p) => {
  const got = await resolveInsideWorkspace(openRoot, p);
  return got === null ? null : path.relative(openRoot, got);
};
t('a file in the project', await inside(openDoc), 'notes.md');
t('by relative path', await inside('sub/deep.md'), path.join('sub', 'deep.md'));
t('a file in another project', await inside(outsider), null);
t('traversal out', await inside('../not-mine/secret.md'), null);
t('an absolute path elsewhere', await inside('/etc/hostname'), null);
t('a path that does not exist', await inside('sub/ghost.md'), null);
// Opening one hands the request to a file manager, which is not what
// naming a file in a comment asks for.
t('a directory', await inside('sub'), null);
// The containment test runs on the resolved target: a link inside the
// project pointing out of it must not smuggle its target through.
try {
  symlinkSync(outsider, path.join(openRoot, 'escape.md'));
  t('a symlink pointing out of the project', await inside('escape.md'), null);
} catch {
  console.log('skip  symlink case (not permitted here)');
}

rmSync(base, { recursive: true, force: true });
rmSync(build, { recursive: true, force: true });
done('workspace-root');
