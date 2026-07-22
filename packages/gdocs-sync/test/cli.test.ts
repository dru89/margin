import { describe, expect, it } from 'vitest';
import { parsePushArgs, scopeHintLines } from '../src/cli.ts';
import { DRIVE_FILE_SCOPE, DRIVE_SCOPE } from '../src/auth.ts';

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

describe('scopeHintLines — 403/404 advice matches what would actually fix it', () => {
  const base = { docId: DOC_ID, status: 404, configDir: '/home/u/.config/gdocs-sync' };

  it('full-drive token: no scope advice (the doc really is missing or unshared)', () => {
    const lines = scopeHintLines({ ...base, tokenScopes: [DRIVE_SCOPE], clientScopes: [] });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('404');
  });

  it('drive.file token + broader client config: advises re-running `gdocs auth`', () => {
    const lines = scopeHintLines({
      ...base,
      tokenScopes: [DRIVE_FILE_SCOPE],
      clientScopes: [DRIVE_SCOPE],
    });
    const text = lines.join('\n');
    expect(text).toContain('drive.file');
    expect(text).toContain('re-authorize');
    expect(text).not.toContain('"scopes"');
  });

  it('drive.file token, no broader client: points at org config first, self-made second', () => {
    const lines = scopeHintLines({ ...base, tokenScopes: [DRIVE_FILE_SCOPE], clientScopes: [] });
    const text = lines.join('\n');
    expect(text.indexOf('org distributes')).toBeGreaterThan(-1);
    expect(text.indexOf('org distributes')).toBeLessThan(text.indexOf('"scopes"'));
    expect(text).toContain('/home/u/.config/gdocs-sync');
    expect(text).toContain('scopes will not help');
  });
});
