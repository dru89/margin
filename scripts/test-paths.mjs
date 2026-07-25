#!/usr/bin/env node
/**
 * Agent-supplied path validation.
 *
 * This is the boundary between untrusted agent output and the user's disk.
 * CLAUDE.md's rule is that the agent's only write surfaces are Margin's own
 * (`.margin/`) — a hole here means a proposal lands anywhere the process can
 * reach, and the user's Accept is what materializes it. Failures here are
 * severe and silent, which is exactly the profile that earns a test.
 *
 *   node scripts/test-paths.mjs
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { load, reporter } from './lib/compile.mjs';

const { mod, dir: build } = await load('src/main/proposalsStore.ts');
const { validateProposalPath } = mod;
const { t, head, done } = reporter();

const root = mkdtempSync(path.join(tmpdir(), 'margin-ws-'));
mkdirSync(path.join(root, 'docs'), { recursive: true });
writeFileSync(path.join(root, 'taken.md'), 'already here\n');

const err = async (raw) => {
  const r = await validateProposalPath(root, raw);
  return 'error' in r ? 'rejected' : r.rel;
};

head('paths that should be accepted');
t('a plain file', await err('notes.md'), 'notes.md');
t('a nested file', await err('docs/notes.md'), 'docs/notes.md');
t('redundant separators are normalized', await err('docs//notes.md'), path.join('docs', 'notes.md'));
t('a leading slash is stripped, not treated as absolute', await err('/notes.md'), 'notes.md');

head('escaping the workspace');
t('parent traversal', await err('../outside.md'), 'rejected');
t('traversal in the middle', await err('docs/../../outside.md'), 'rejected');
t('traversal that normalizes back inside is still refused', await err('docs/../notes.md'), 'notes.md');
// Current behaviour, not an endorsement: the leading slash is stripped, so
// this stays inside the workspace but lands somewhere the agent did not ask
// for, with no error telling it so. Contained, and still gated by Accept —
// see #133 for whether it should be refused outright instead.
t('an absolute path is re-read as workspace-relative', await err('/etc/passwd'), path.join('etc', 'passwd'));
t('a deep traversal chain', await err('../../../../../../tmp/evil.md'), 'rejected');

head('hidden segments — .margin is ours, not the agent’s to target');
t('a dotfile', await err('.bashrc'), 'rejected');
t('a dotdir', await err('.margin/agent-notes.md'), 'rejected');
t('a nested dotdir', await err('docs/.git/config'), 'rejected');

head('degenerate input');
t('empty', await err(''), 'rejected');
t('a bare dot', await err('.'), 'rejected');
t('only separators', await err('///'), 'rejected');

head('proposals are for new files only');
t('a path that already exists', await err('taken.md'), 'rejected');

rmSync(root, { recursive: true, force: true });
rmSync(build, { recursive: true, force: true });
done('path-validation');
