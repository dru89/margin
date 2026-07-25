#!/usr/bin/env node
/**
 * Project-root derivation (DECISIONS §63).
 *
 * Which folder a document belongs to decides which `.margin/` its
 * discussion, model preference, notes and proposals live in. Get it wrong
 * and a project silently changes shape underneath the author (#123), so
 * the precedence and both its guards are asserted here.
 *
 *   node scripts/test-workspace.mjs
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir, homedir } from 'os';
import path from 'path';
import { load, reporter } from './lib/compile.mjs';

const { mod, dir: build } = await load('src/main/workspace.ts');
const { findWorkspaceRoot } = mod;
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

head('precedence: marker, then git, then the file’s own folder');
const plain = make('plain');
t('no marker, no repo', await rootOf(doc(plain)), 'plain');

const repo = make('repo', { git: true });
const repoDocs = make('repo/docs');
t('a repo with no marker uses its toplevel', await rootOf(doc(repoDocs)), 'repo');

const marked = make('marked', { marker: true });
const markedSub = make('marked/sub');
t('a marker claims files beneath it', await rootOf(doc(markedSub)), 'marked');

head('nested markers are deliberately nested projects');
make('outer', { marker: true });
const inner = make('outer/inner', { marker: true });
t('the nearest marker wins', await rootOf(doc(inner)), path.join('outer', 'inner'));

head('guard: the deeper of marker and repo wins');
// `.margin/` is created automatically, so a stray marker high up is expected.
// Without this guard it would swallow every repo beneath it.
make('stray', { marker: true });
const strayRepo = make('stray/repo', { git: true });
t('a repo below a stray marker keeps its own root', await rootOf(doc(strayRepo)), path.join('stray', 'repo'));
const bothAt = make('both', { git: true, marker: true });
const bothDocs = make('both/docs');
t('marker and repo at the same place agree', await rootOf(doc(bothDocs)), 'both');

head('guard: the walk skips the home directory itself');
// A loose ~/notes.md creates ~/.margin; without this, every file anywhere
// under home would inherit home as its project.
t('a file directly in home resolves to home',
  await findWorkspaceRoot(path.join(homedir(), '__margin_probe_does_not_exist.md')), homedir());

head('#123: a nested file does not narrow an established project');
const proj = make('proj', { marker: true });
const projSub = make('proj/sub');
doc(proj, 'alpha.md');
t('opening a nested file keeps the project', await rootOf(doc(projSub, 'nested.md')), 'proj');

rmSync(base, { recursive: true, force: true });
rmSync(build, { recursive: true, force: true });
done('workspace-root');
