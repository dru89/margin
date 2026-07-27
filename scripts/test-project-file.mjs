#!/usr/bin/env node
/**
 * `margin.json`, the project's record of itself (spec §2, #167).
 *
 * Two decisions are asserted. **Reading falls back, writing does not** —
 * an existing project keeps working untouched, and the first change
 * moves it forward, which is the whole migration. And **a project can be
 * named**, which is the reason the file holds anything beyond the model
 * preference it replaces.
 *
 *   node scripts/test-project-file.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { load, reporter } from './lib/compile.mjs';

const { mod, dir: build } = await load('src/main/projectFile.ts');
const { loadProjectFile, saveProjectFile, projectName, projectFilePath } = mod;
const { t, head, done } = reporter();

const base = mkdtempSync(path.join(tmpdir(), 'margin-project-'));
let n = 0;
/** A project folder, optionally seeded with either record. */
const project = ({ margin, legacy } = {}) => {
  const dir = path.join(base, `p${n++}`);
  mkdirSync(dir, { recursive: true });
  if (margin !== undefined) {
    writeFileSync(path.join(dir, 'margin.json'), typeof margin === 'string' ? margin : JSON.stringify(margin));
  }
  if (legacy !== undefined) {
    mkdirSync(path.join(dir, '.margin'), { recursive: true });
    writeFileSync(path.join(dir, '.margin', 'project.json'), JSON.stringify(legacy));
  }
  return dir;
};
const onDisk = (dir) => JSON.parse(readFileSync(path.join(dir, 'margin.json'), 'utf8'));

head('reading');
t('a project with no record at all', (await loadProjectFile(project())).version, 1);
t('margin.json', (await loadProjectFile(project({ margin: { version: 1, model: 'opus' } }))).model, 'opus');
// Every project that exists today is this one.
t('the legacy .margin/project.json', (await loadProjectFile(project({ legacy: { version: 1, model: 'sonnet' } }))).model, 'sonnet');
// Not merged: the new file is the record once it exists, so a stale
// legacy value cannot reach back in and override it.
t('margin.json wins outright over the legacy file',
  (await loadProjectFile(project({ margin: { version: 1, model: 'opus' }, legacy: { version: 1, model: 'sonnet' } }))).model,
  'opus');

head('a hand-editable file can hold anything');
// It sits in the repo where a person edits it, so unreadable content has
// to yield defaults rather than take the app down.
t('malformed JSON', (await loadProjectFile(project({ margin: '{ not json' }))).version, 1);
t('valid JSON that is not an object', (await loadProjectFile(project({ margin: '"nope"' }))).version, 1);
t('an array', (await loadProjectFile(project({ margin: '[1,2]' }))).version, 1);

head('writing always lands in margin.json');
{
  const dir = project({ legacy: { version: 1, model: 'sonnet' } });
  await saveProjectFile(dir, { effort: 'high' });
  // The migration: read from the old place, write to the new one, and a
  // value that was only ever in the legacy file comes along.
  t('the new file appears', existsSync(path.join(dir, 'margin.json')), true);
  t('carrying the legacy value forward', onDisk(dir).model, 'sonnet');
  t('and the patch', onDisk(dir).effort, 'high');
  // Left alone rather than deleted: it is inert once margin.json exists,
  // and removing a file nobody asked us to remove is not ours to do.
  t('the legacy file is not deleted', existsSync(path.join(dir, '.margin', 'project.json')), true);
}
{
  const dir = project();
  await saveProjectFile(dir, { name: 'Rollout plan' });
  await saveProjectFile(dir, { model: 'haiku' });
  t('successive writes merge', `${onDisk(dir).name}/${onDisk(dir).model}`, 'Rollout plan/haiku');
  // A hand-edited file should not accumulate keys the author never wrote.
  t('undefined keys are not written', Object.keys(onDisk(dir)).sort().join(','), 'model,name,version');
}

head('a project can be named');
const named = { version: 1, name: 'Q3 Incident Review' };
t('its stated name', projectName('/tmp/some-folder', named), 'Q3 Incident Review');
t('else the folder', projectName('/tmp/some-folder', { version: 1 }), 'some-folder');
// Whitespace is not a name; falling through beats an empty header.
t('a blank name falls back', projectName('/tmp/some-folder', { version: 1, name: '   ' }), 'some-folder');

head('where it lives');
t('at the project root, beside .margin/ rather than inside it',
  path.basename(projectFilePath('/tmp/proj')), 'margin.json');

rmSync(base, { recursive: true, force: true });
rmSync(build, { recursive: true, force: true });
done('project-file');
