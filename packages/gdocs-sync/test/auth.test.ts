import { createServer, type Server } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  authStatus,
  authorize,
  configDir,
  getAccessToken,
  loadClient,
  saveClientConfig,
  setFallbackClient,
  signOut,
  DRIVE_FILE_SCOPE,
} from '../src/auth.ts';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gdocs-auth-'));
  process.env.GDOCS_SYNC_CONFIG_DIR = dir;
});

afterEach(async () => {
  delete process.env.GDOCS_SYNC_CONFIG_DIR;
  setFallbackClient(null);
  await fs.rm(dir, { recursive: true, force: true });
});

const GOOGLE_SHAPE = JSON.stringify({
  installed: {
    client_id: 'id-123.apps.googleusercontent.com',
    client_secret: 'secret-xyz',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
  },
});

async function writeToken(overrides: Partial<Record<string, unknown>> = {}): Promise<void> {
  await fs.writeFile(
    path.join(dir, 'google-token.json'),
    JSON.stringify({
      accessToken: 'tok',
      refreshToken: 'ref',
      expiresAt: Date.now() + 3600_000,
      scopes: [DRIVE_FILE_SCOPE],
      ...overrides,
    }),
  );
}

describe('config resolution + client management', () => {
  it('GDOCS_SYNC_CONFIG_DIR overrides the default candidates', () => {
    expect(configDir()).toBe(dir);
  });

  it('saveClientConfig validates, writes 0600, and loadClient round-trips', async () => {
    const file = await saveClientConfig(GOOGLE_SHAPE);
    expect(file).toBe(path.join(dir, 'google-oauth.json'));
    const mode = (await fs.stat(file)).mode & 0o777;
    expect(mode).toBe(0o600);
    const client = await loadClient();
    expect(client.clientId).toBe('id-123.apps.googleusercontent.com');
    expect(client.clientSecret).toBe('secret-xyz');
  });

  it('saveClientConfig accepts the flat shape and rejects garbage without writing', async () => {
    await saveClientConfig(JSON.stringify({ clientId: 'a', clientSecret: 'b' }));
    expect((await loadClient()).clientId).toBe('a');
    await expect(saveClientConfig(JSON.stringify({ nope: true }))).rejects.toThrow(
      /client_id/,
    );
  });

  it('fallback client is used only when no file exists', async () => {
    setFallbackClient({ clientId: 'fb-id', clientSecret: 'fb-secret' });
    expect((await loadClient()).clientId).toBe('fb-id');
    await saveClientConfig(GOOGLE_SHAPE);
    expect((await loadClient()).clientId).toBe('id-123.apps.googleusercontent.com');
  });
});

describe('authStatus + signOut', () => {
  it('reports none/file/fallback client sources and token connection', async () => {
    expect(await authStatus()).toMatchObject({ clientSource: 'none', connected: false });
    setFallbackClient({ clientId: 'fb', clientSecret: 's' });
    expect((await authStatus()).clientSource).toBe('fallback');
    await saveClientConfig(GOOGLE_SHAPE);
    await writeToken();
    const status = await authStatus();
    expect(status).toMatchObject({ clientSource: 'file', connected: true });
    expect(status.scopes).toEqual([DRIVE_FILE_SCOPE]);
  });

  it('a token with narrower scopes than required is not "connected"', async () => {
    await writeToken({ scopes: ['https://www.googleapis.com/auth/drive.appdata'] });
    expect((await authStatus()).connected).toBe(false);
  });

  it('signOut removes the token but keeps the client', async () => {
    await saveClientConfig(GOOGLE_SHAPE);
    await writeToken();
    await signOut();
    expect(await authStatus()).toMatchObject({ clientSource: 'file', connected: false });
    await signOut(); // idempotent
  });
});

describe('getAccessToken (UAUTH-1..3 file-backed)', () => {
  it('returns a fresh, sufficiently scoped cached token', async () => {
    await writeToken();
    expect(await getAccessToken()).toBe('tok');
  });

  it('rejects an unexpired but narrow token', async () => {
    await writeToken({ scopes: [] });
    expect(await getAccessToken()).toBeNull();
  });

  it('returns null when expired with no refresh token', async () => {
    await writeToken({ expiresAt: Date.now() - 1000, refreshToken: undefined });
    expect(await getAccessToken()).toBeNull();
  });
});

describe('UAUTH-4 — authorize() end-to-end against a fake token endpoint', () => {
  let tokenServer: Server;
  let tokenUri: string;
  let tokenBodies: URLSearchParams[];

  beforeEach(async () => {
    tokenBodies = [];
    tokenServer = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        tokenBodies.push(new URLSearchParams(raw));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            access_token: 'live-tok',
            refresh_token: 'live-ref',
            expires_in: 3600,
            scope: DRIVE_FILE_SCOPE,
          }),
        );
      });
    });
    await new Promise<void>((r) => tokenServer.listen(0, '127.0.0.1', r));
    const addr = tokenServer.address();
    tokenUri = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/token`;
  });

  afterEach(() => tokenServer.close());

  it('loopback + PKCE round-trip: consent URL → callback → token cached', async () => {
    await saveClientConfig(
      JSON.stringify({
        installed: { client_id: 'cid', client_secret: 'cs', token_uri: tokenUri },
      }),
    );

    const done = authorize([DRIVE_FILE_SCOPE], {
      onUrl: (url) => {
        const u = new URL(url);
        expect(u.searchParams.get('code_challenge_method')).toBe('S256');
        expect(u.searchParams.get('scope')).toBe(DRIVE_FILE_SCOPE);
        const redirect = u.searchParams.get('redirect_uri')!;
        const state = u.searchParams.get('state')!;
        void fetch(`${redirect}?code=auth-code-1&state=${encodeURIComponent(state)}`);
      },
    });

    const token = await done;
    expect(token.accessToken).toBe('live-tok');
    expect(token.scopes).toEqual([DRIVE_FILE_SCOPE]);
    // The token exchange carried the PKCE verifier and the code.
    const body = tokenBodies[0]!;
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('auth-code-1');
    expect(body.get('code_verifier')).toBeTruthy();
    // And the cache is now good for API calls.
    expect(await getAccessToken()).toBe('live-tok');
  });

  it('a mismatched state rejects instead of exchanging the code', async () => {
    await saveClientConfig(
      JSON.stringify({
        installed: { client_id: 'cid', client_secret: 'cs', token_uri: tokenUri },
      }),
    );
    const done = authorize([DRIVE_FILE_SCOPE], {
      onUrl: (url) => {
        const redirect = new URL(url).searchParams.get('redirect_uri')!;
        void fetch(`${redirect}?code=stolen&state=WRONG`);
      },
    });
    await expect(done).rejects.toThrow(/state mismatch/);
    expect(tokenBodies).toHaveLength(0);
  });

  it('an AbortSignal cancels the pending flow', async () => {
    await saveClientConfig(GOOGLE_SHAPE);
    const ctl = new AbortController();
    const done = authorize([DRIVE_FILE_SCOPE], {
      onUrl: () => ctl.abort(),
      signal: ctl.signal,
    });
    await expect(done).rejects.toThrow(/cancelled/);
  });
});

describe('scope satisfaction + config scopes (issue #48)', () => {
  it('a full-drive token satisfies a drive.file requirement', async () => {
    await writeToken({ scopes: ['https://www.googleapis.com/auth/drive'] });
    expect(await getAccessToken()).toBe('tok');
    expect((await authStatus()).connected).toBe(true);
  });

  it('drive.file does not satisfy a full-drive requirement', async () => {
    await writeToken(); // drive.file only
    expect(await getAccessToken(['https://www.googleapis.com/auth/drive'])).toBeNull();
  });

  it('a "scopes" array in the client JSON becomes the authorize default', async () => {
    await saveClientConfig(
      JSON.stringify({
        installed: { client_id: 'cid', client_secret: 'cs' },
        scopes: ['https://www.googleapis.com/auth/drive'],
      }),
    );
    const ctl = new AbortController();
    let consentScope = '';
    await authorize(undefined, {
      signal: ctl.signal,
      onUrl: (url) => {
        consentScope = new URL(url).searchParams.get('scope') ?? '';
        ctl.abort();
      },
    }).catch(() => {});
    expect(consentScope).toBe('https://www.googleapis.com/auth/drive');
  });
});

describe('share-domain in the client JSON (issue #53)', () => {
  it('parses a top-level share-domain key', async () => {
    await saveClientConfig(
      JSON.stringify({ clientId: 'a', clientSecret: 'b', 'share-domain': 'hays.fm' }),
    );
    expect((await loadClient()).shareDomain).toBe('hays.fm');
  });
});
