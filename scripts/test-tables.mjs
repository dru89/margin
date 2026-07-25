#!/usr/bin/env node
/**
 * GFM table formatting (issue #5).
 *
 * The formatter rewrites the author's document in place, so a defect
 * damages prose rather than just looking wrong — escaped pipes swallowed,
 * alignment markers lost, a non-table line reflowed.
 *
 *   node scripts/test-tables.mjs
 */
import { rmSync } from 'fs';
import { load, reporter } from './lib/compile.mjs';

const { mod, dir: build } = await load('src/shared/tables.ts');
const { isTableLine, formatTableLines } = mod;
const { t, head, done } = reporter();
const fmt = (...lines) => formatTableLines(lines);

head('recognising a table line');
t('a plain row', isTableLine('| a | b |'), true);
t('an indented row', isTableLine('   | a |'), true);
t('prose', isTableLine('not a table'), false);
t('a pipe later in the line', isTableLine('text | more'), false);
t('an empty line', isTableLine(''), false);

head('padding so the pipes line up');
t('ragged cells are padded to the widest',
  fmt('| a | bbbb |', '| --- | --- |', '| cccc | d |'),
  ['| a    | bbbb |', '| ---- | ---- |', '| cccc | d    |']);
t('an already-formatted table is left alone (idempotent)',
  fmt('| a    | bbbb |', '| ---- | ---- |', '| cccc | d    |'),
  ['| a    | bbbb |', '| ---- | ---- |', '| cccc | d    |']);
t('formatting twice matches formatting once',
  formatTableLines(fmt('|a|bbbb|', '|---|---|', '|cccc|d|')),
  fmt('|a|bbbb|', '|---|---|', '|cccc|d|'));

head('alignment markers survive');
// Note the middle column: centre-aligned cells are actually centred, not
// just left-padded. Right-aligned cells pad on the left.
t('left, centre and right each pad on the correct side',
  fmt('| a | b | c |', '| :-- | :-: | --: |', '| 1 | 2 | 3 |'),
  ['| a   |  b  |   c |', '| :-- | :-: | --: |', '| 1   |  2  |   3 |']);

head('content that could be mistaken for structure');
// The escaped pipe does not split the cell, so column one is 6 wide; column
// two pads to its delimiter's 3.
t('an escaped pipe stays inside its cell',
  fmt('| a \\| b | c |', '| --- | --- |'),
  ['| a \\| b | c   |', '| ------ | --- |']);
t('empty cells are kept, not dropped',
  fmt('| a |  | c |', '| --- | --- | --- |'),
  ['| a   |     | c   |', '| --- | --- | --- |']);

head('ragged rows');
t('a short row is padded out to the table width',
  fmt('| a | b | c |', '| --- | --- | --- |', '| 1 |'),
  ['| a   | b   | c   |', '| --- | --- | --- |', '| 1   |     |     |']);

rmSync(build, { recursive: true, force: true });
done('table');
