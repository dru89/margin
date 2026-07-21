import { describe, expect, it } from 'vitest';
import { splitFrontmatter } from '../src/markdown.ts';
import { emitFrontmatter } from '../src/meta.ts';

describe('frontmatter preservation, folded scalars, multi-author (issue #20)', () => {
  const RICH = `---
title: Old Title
purpose: >
  A long description that will be folded
  into a single paragraph by the parser.
audience: eng-leadership
author:
  - Drew Hays
  - Claude
custom-flag: true
date: 2026-07-01
---
Body text.
`;

  it('folded scalars parse and unknown keys are captured verbatim', () => {
    const { meta, entries, body } = splitFrontmatter(RICH);
    expect(meta.title).toBe('Old Title');
    expect(meta.authors).toEqual(['Drew Hays', 'Claude']);
    expect(meta.author).toBe('Drew Hays');
    expect(meta.date).toBe('2026-07-01');
    expect(body).toBe('Body text.\n');
    const purpose = entries.find((e) => e.key === 'purpose')!;
    expect(purpose.lines).toEqual([
      'purpose: >',
      '  A long description that will be folded',
      '  into a single paragraph by the parser.',
    ]);
    expect(entries.map((e) => e.key)).toEqual([
      'title', 'purpose', 'audience', 'author', 'custom-flag', 'date',
    ]);
  });

  it('folded (>) joins with spaces; literal (|) keeps newlines — for contract keys', () => {
    const folded = splitFrontmatter('---\nsubtitle: >\n  line one\n  line two\n---\nx\n');
    expect(folded.meta.subtitle).toBe('line one line two');
  });

  it('emit-with-preserve: contract keys update in place, unknown keys survive, order holds', () => {
    const { entries } = splitFrontmatter(RICH);
    const fm = emitFrontmatter(
      { title: 'New Title', subtitle: 'Now With Subtitle', authors: ['Drew Hays', 'Claude'], author: 'Drew Hays', date: '2026-07-21' },
      entries,
    );
    const lines = fm.split('\n');
    expect(lines).toEqual([
      '---',
      'title: New Title',           // updated, original position
      'purpose: >',                 // unknown, verbatim
      '  A long description that will be folded',
      '  into a single paragraph by the parser.',
      'audience: eng-leadership',   // unknown, verbatim
      'author:',                    // updated list form, original position
      '  - Drew Hays',
      '  - Claude',
      'custom-flag: true',          // unknown, verbatim
      'date: 2026-07-21',           // updated, original position
      'subtitle: Now With Subtitle', // new contract key appends
      '---',
      '',
      '',
    ]);
  });

  it('a contract key the doc no longer has is dropped; no preserve = clean emit', () => {
    const { entries } = splitFrontmatter('---\ntitle: T\nsubtitle: Gone\nkeep-me: yes\n---\nx\n');
    const fm = emitFrontmatter({ title: 'T' }, entries);
    expect(fm).toContain('keep-me: yes');
    expect(fm).not.toContain('subtitle');
    expect(emitFrontmatter({ authors: ['A', 'B'], author: 'A' })).toBe(
      '---\nauthor:\n  - A\n  - B\n---\n\n',
    );
  });
});
