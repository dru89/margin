#!/usr/bin/env node
/**
 * Git is optional (#145, and the audit in #144).
 *
 * Margin degrades without git everywhere by design — History and restore
 * are gated on `inGitRepo`, and the project root keys off `.margin/`
 * rather than a repo (DECISIONS §63). Project creation was the one write
 * path that did not: it wrote the folder and every seed file and *then*
 * threw on `git init`, leaving a project on disk that Margin never opened
 * and that a retry refused as already existing.
 *
 * These cases run with git removed from PATH, which is the only honest
 * way to assert the behavior — a mock would be asserting the mock.
 *
 *   node scripts/test-git.mjs
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { load, reporter } from './lib/compile.mjs';

const { mod, dir: build } = await load('src/main/git.ts');
const { initProjectRepo, isInRepo } = mod;
const { t, head, done } = reporter();

const base = mkdtempSync(path.join(tmpdir(), 'margin-git-'));
const project = (name) => {
  const dir = path.join(base, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'doc.md'), '# Seed\n');
  mkdirSync(path.join(dir, '.margin'), { recursive: true });
  return dir;
};

/** Run `fn` with nothing named git anywhere on PATH. */
const withoutGit = async (fn) => {
  const real = process.env.PATH;
  process.env.PATH = path.join(base, 'empty-bin');
  mkdirSync(process.env.PATH, { recursive: true });
  try {
    return await fn();
  } finally {
    process.env.PATH = real;
  }
};

const threw = async (fn) => {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
};

head('creating a project without git');
const bare = project('no-git');
// The whole bug: this threw, after the files were already on disk.
t('does not throw', await withoutGit(() => threw(() => initProjectRepo(bare, 'Initial'))), false);
t('the seed files are still there', existsSync(path.join(bare, 'doc.md')), true);
t('and no repo was made', existsSync(path.join(bare, '.git')), false);
// A project with no repo is a working project; this is what gates History.
t('which the app can tell', await withoutGit(() => isInRepo(path.join(bare, 'doc.md'))), false);

head('creating a project with git');
const repo = project('with-git');
t('does not throw', await threw(() => initProjectRepo(repo, 'Initial')), false);
t('a repo exists', existsSync(path.join(repo, '.git')), true);
t('the app can tell', await isInRepo(path.join(repo, 'doc.md')), true);
t('the seed files are committed',
  execFileSync('git', ['log', '--oneline', '--name-only'], { cwd: repo, encoding: 'utf8' }).includes('doc.md'),
  true);

head('git present but with no identity configured');
// The failure the original code *did* anticipate: the repo is created and
// the commit fails. Still not fatal, and still not a reason to lose the
// project. (`-c user.email=` empties it, which git refuses to commit with.)
const unnamed = project('no-identity');
execFileSync('git', ['init', '-q'], { cwd: unnamed });
execFileSync('git', ['config', 'user.email', ''], { cwd: unnamed });
execFileSync('git', ['config', 'user.name', ''], { cwd: unnamed });
t('does not throw', await threw(() => initProjectRepo(unnamed, 'Initial')), false);
t('the project survives', existsSync(path.join(unnamed, 'doc.md')), true);

rmSync(base, { recursive: true, force: true });
rmSync(build, { recursive: true, force: true });
done('git-optional');
