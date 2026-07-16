/**
 * OAuth for the live tier: installed-app loopback + PKCE against the
 * client in ~/.config/margin/google-oauth.json (Google's downloaded
 * `{"installed": {...}}` shape, or a flat `{clientId, clientSecret}`).
 *
 * UAUTH lessons applied: the token cache persists *granted* scopes and
 * getAccessToken() compares them to what's required (an unexpired
 * narrow token must not pass); refresh failure falls through to
 * "re-run auth" rather than wedging; invalid_client gets its own
 * message (re-auth can't fix a dead client).
 *
 * Self-contained on purpose (node can run it directly: `npm run auth`).
 */
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'margin');
const CLIENT_PATH = path.join(CONFIG_DIR, 'google-oauth.json');
const TOKEN_PATH = path.join(CONFIG_DIR, 'google-token.json');

interface ClientConfig {
  clientId: string;
  clientSecret: string;
  authUri: string;
  tokenUri: string;
}

interface TokenCache {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms. */
  expiresAt: number;
  /** Scopes actually granted (from the token response), not requested. */
  scopes: string[];
}

export async function loadClient(): Promise<ClientConfig> {
  const raw = JSON.parse(await fs.readFile(CLIENT_PATH, 'utf8')) as Record<string, unknown>;
  const installed = (raw.installed ?? raw.web ?? raw) as Record<string, string>;
  const clientId = installed.client_id ?? (raw.clientId as string | undefined);
  const clientSecret = installed.client_secret ?? (raw.clientSecret as string | undefined);
  if (!clientId || !clientSecret) {
    throw new Error(`No client_id/client_secret found in ${CLIENT_PATH}`);
  }
  return {
    clientId,
    clientSecret,
    authUri: installed.auth_uri ?? 'https://accounts.google.com/o/oauth2/auth',
    tokenUri: installed.token_uri ?? 'https://oauth2.googleapis.com/token',
  };
}

async function loadToken(): Promise<TokenCache | null> {
  try {
    const t = JSON.parse(await fs.readFile(TOKEN_PATH, 'utf8')) as TokenCache;
    return Array.isArray(t.scopes) && typeof t.accessToken === 'string' ? t : null;
  } catch {
    return null;
  }
}

async function saveToken(token: TokenCache): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(TOKEN_PATH, JSON.stringify(token, null, 2) + '\n', { mode: 0o600 });
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(client: ClientConfig, params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(client.tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      ...params,
    }).toString(),
  });
  const body = (await res.json()) as TokenResponse;
  if (!res.ok || body.error) {
    if (body.error === 'invalid_client' || body.error === 'unauthorized_client') {
      throw new Error(
        `OAuth client is invalid (${body.error}). Re-running auth will not help — the client ID in ${CLIENT_PATH} needs to be replaced.`,
      );
    }
    throw new Error(`Token request failed: ${body.error ?? res.status} ${body.error_description ?? ''}`.trim());
  }
  return body;
}

function cacheFrom(body: TokenResponse, previous?: TokenCache | null): TokenCache {
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? previous?.refreshToken,
    expiresAt: Date.now() + (body.expires_in - 60) * 1000,
    scopes: body.scope ? body.scope.split(' ') : (previous?.scopes ?? []),
  };
}

/** Interactive loopback flow. Prints the consent URL; resolves when the user approves. */
export async function authorize(scopes: string[] = [DRIVE_FILE_SCOPE]): Promise<TokenCache> {
  const client = await loadClient();
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('base64url');
  let redirectUri = '';

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const err = url.searchParams.get('error');
      const gotState = url.searchParams.get('state');
      const gotCode = url.searchParams.get('code');
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<body style="font-family:sans-serif"><h3>gdocs-sync: you can close this tab.</h3></body>');
      server.close();
      if (err) reject(new Error(`Consent denied: ${err}`));
      else if (gotState !== state) reject(new Error('OAuth state mismatch'));
      else if (!gotCode) reject(new Error('No code in callback'));
      else resolve(gotCode);
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const authUrl = new URL(client.authUri);
      authUrl.search = new URLSearchParams({
        client_id: client.clientId,
        redirect_uri: `http://127.0.0.1:${port}/callback`,
        response_type: 'code',
        scope: scopes.join(' '),
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        access_type: 'offline',
        prompt: 'consent',
      }).toString();
      redirectUri = `http://127.0.0.1:${port}/callback`;
      console.log(`\nOpen this URL in your browser to authorize:\n\n${authUrl.toString()}\n`);
    });
    server.on('error', reject);
  });

  const body = await tokenRequest(client, {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  });
  const token = cacheFrom(body);
  await saveToken(token);
  console.log(`Authorized. Granted scopes: ${token.scopes.join(', ')}`);
  console.log(`Token cached at ${TOKEN_PATH}`);
  return token;
}

/**
 * Access token for the live tier: cached if fresh and sufficiently
 * scoped, refreshed if expired, otherwise null (callers skip — the
 * live suite must skip, not fail, when unauthenticated).
 */
export async function getAccessToken(required: string[] = [DRIVE_FILE_SCOPE]): Promise<string | null> {
  const cached = await loadToken();
  if (!cached) return null;
  if (!required.every((s) => cached.scopes.includes(s))) return null; // narrow token ≠ valid token
  if (Date.now() < cached.expiresAt) return cached.accessToken;
  if (!cached.refreshToken) return null;
  try {
    const client = await loadClient();
    const body = await tokenRequest(client, {
      grant_type: 'refresh_token',
      refresh_token: cached.refreshToken,
    });
    const token = cacheFrom(body, cached);
    await saveToken(token);
    return token.accessToken;
  } catch (err) {
    console.warn(`Token refresh failed (${err instanceof Error ? err.message : err}); re-run auth.`);
    return null;
  }
}

// CLI entry: `node src/auth.ts` (or `npm run auth`).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  authorize().then(
    () => process.exit(0),
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
