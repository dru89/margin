import { describe, expect, it } from 'vitest';
import { parsePushArgs } from '../src/cli.ts';

const DOC_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg';
const DOC_URL = `https://docs.google.com/document/d/${DOC_ID}/edit`;

describe('parsePushArgs — target resolution before file reads', () => {
  it('documented single-doc form: push <file.md> <url>', () => {
    expect(parsePushArgs(['notes.md', DOC_URL])).toEqual({
      specs: ['notes.md'],
      target: DOC_ID,
      writeUrl: false,
    });
  });

  it('bare docId works in place of a url', () => {
    expect(parsePushArgs(['notes.md', DOC_ID]).target).toBe(DOC_ID);
  });

  it('--doc flag form, tab specs pass through untouched', () => {
    const parsed = parsePushArgs(['Overview=a.md', 'Design=b.md', '--doc', DOC_URL]);
    expect(parsed.specs).toEqual(['Overview=a.md', 'Design=b.md']);
    expect(parsed.target).toBe(DOC_ID);
  });

  it('no target: specs only, --write-url picked up', () => {
    expect(parsePushArgs(['notes.md', '--write-url'])).toEqual({
      specs: ['notes.md'],
      target: null,
      writeUrl: true,
    });
  });

  it('rejects two targets', () => {
    expect(() => parsePushArgs(['notes.md', DOC_URL, '--doc', DOC_URL])).toThrow(
      /more than one doc target/,
    );
  });

  it('rejects --doc with a non-doc value', () => {
    expect(() => parsePushArgs(['notes.md', '--doc', 'nope'])).toThrow(/not a Google Doc/);
  });

  it('rejects --doc without a value', () => {
    expect(() => parsePushArgs(['notes.md', '--doc'])).toThrow(/requires a value/);
  });

  it('rejects zero files', () => {
    expect(() => parsePushArgs([DOC_URL])).toThrow(/at least one markdown file/);
  });
});
