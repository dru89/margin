/**
 * OAuth: installed-app loopback + PKCE against the client in
 * ~/.config/gdocs-sync/google-oauth.json (Google's downloaded
 * `{"installed": {...}}` shape, or a flat `{clientId, clientSecret}`).
 * ~/.config/margin/ is honored as a legacy fallback location, and
 * GDOCS_SYNC_CONFIG_DIR overrides both (tests, embedding apps).
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
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';

// Scope satisfaction is superset-aware: a token granted full drive
// covers a drive.file requirement (issue #48 — internal clients can be
// approved for /auth/drive so fetch works on any doc the user can read).
const SCOPE_IMPLIES: Record<string, string[]> = {
  [DRIVE_SCOPE]: [DRIVE_FILE_SCOPE],
};

function scopeSatisfied(granted: string[], required: string): boolean {
  if (granted.includes(required)) return true;
  return granted.some((g) => SCOPE_IMPLIES[g]?.includes(required) ?? false);
}

const CLIENT_FILE = 'google-oauth.json';
const TOKEN_FILE = 'google-token.json';

function candidateDirs(): string[] {
  const env = process.env.GDOCS_SYNC_CONFIG_DIR;
  if (env) return [env];
  return [
    path.join(os.homedir(), '.config', 'gdocs-sync'),
    path.join(os.homedir(), '.config', 'margin'),
  ];
}

/** The active config dir: first candidate holding a client file, else the preferred one. */
export function configDir(): string {
  const dirs = candidateDirs();
  return dirs.find((dir) => existsSync(path.join(dir, CLIENT_FILE))) ?? dirs[0]!;
}

function clientPath(): string {
  return path.join(configDir(), CLIENT_FILE);
}

function tokenPath(): string {
  return path.join(configDir(), TOKEN_FILE);
}

export interface ClientConfig {
  clientId: string;
  clientSecret: string;
  authUri: string;
  tokenUri: string;
  /** Default scopes to request, from a top-level "scopes" array in the
   * client JSON (user-added; Google's downloaded shape has none). */
  scopes?: string[];
}

interface TokenCache {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms. */
  expiresAt: number;
  /** Scopes actually granted (from the token response), not requested. */
  scopes: string[];
}

// An embedding app may ship a default client used when no client file
// exists on disk (installed-app credentials are not confidential per
// Google's model; the consent screen still gates everything).
let fallbackClient: ClientConfig | null = null;

export function setFallbackClient(
  client: { clientId: string; clientSecret: string } | null,
): void {
  fallbackClient = client
    ? {
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        authUri: 'https://accounts.google.com/o/oauth2/auth',
        tokenUri: 'https://oauth2.googleapis.com/token',
      }
    : null;
}

function parseClientConfig(raw: Record<string, unknown>, source: string): ClientConfig {
  const installed = (raw.installed ?? raw.web ?? raw) as Record<string, string>;
  const clientId = installed.client_id ?? (raw.clientId as string | undefined);
  const clientSecret = installed.client_secret ?? (raw.clientSecret as string | undefined);
  if (!clientId || !clientSecret) {
    throw new Error(`No client_id/client_secret found in ${source}`);
  }
  const scopes =
    Array.isArray(raw.scopes) && raw.scopes.every((x) => typeof x === 'string')
      ? (raw.scopes as string[])
      : undefined;
  return {
    clientId,
    clientSecret,
    authUri: installed.auth_uri ?? 'https://accounts.google.com/o/oauth2/auth',
    tokenUri: installed.token_uri ?? 'https://oauth2.googleapis.com/token',
    ...(scopes !== undefined ? { scopes } : {}),
  };
}

export async function loadClient(): Promise<ClientConfig> {
  const file = clientPath();
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    return parseClientConfig(raw, file);
  } catch (err) {
    if (fallbackClient && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return fallbackClient;
    }
    throw err;
  }
}

/**
 * Validate and persist an OAuth client JSON (Google's downloaded shape
 * or flat {clientId, clientSecret}). Writes to the preferred config dir
 * and returns the path. Throws without writing if the JSON is unusable.
 */
export async function saveClientConfig(rawJson: string): Promise<string> {
  const raw = JSON.parse(rawJson) as Record<string, unknown>;
  parseClientConfig(raw, 'the provided client JSON'); // validate only
  const dir = candidateDirs()[0]!;
  const file = path.join(dir, CLIENT_FILE);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 });
  return file;
}

/** Forget the cached token (the client config stays). */
export async function signOut(): Promise<void> {
  await fs.rm(tokenPath(), { force: true });
}

export interface AuthStatus {
  configDir: string;
  /** Path of the client file if one exists on disk. */
  clientPath: string | null;
  clientSource: 'file' | 'fallback' | 'none';
  /** A token with the required scopes is cached (refresh may still be needed). */
  connected: boolean;
  scopes: string[];
  expiresAt: number | null;
}

export async function authStatus(
  required: string[] = [DRIVE_FILE_SCOPE],
): Promise<AuthStatus> {
  const dir = configDir();
  const file = path.join(dir, CLIENT_FILE);
  const hasFile = existsSync(file);
  const token = await loadToken();
  const scoped = token !== null && required.every((s) => scopeSatisfied(token.scopes, s));
  return {
    configDir: dir,
    clientPath: hasFile ? file : null,
    clientSource: hasFile ? 'file' : fallbackClient ? 'fallback' : 'none',
    connected: scoped && (token.refreshToken !== undefined || Date.now() < token.expiresAt),
    scopes: token?.scopes ?? [],
    expiresAt: token?.expiresAt ?? null,
  };
}

async function loadToken(): Promise<TokenCache | null> {
  try {
    const t = JSON.parse(await fs.readFile(tokenPath(), 'utf8')) as TokenCache;
    return Array.isArray(t.scopes) && typeof t.accessToken === 'string' ? t : null;
  } catch {
    return null;
  }
}

async function saveToken(token: TokenCache): Promise<void> {
  await fs.mkdir(configDir(), { recursive: true });
  await fs.writeFile(tokenPath(), JSON.stringify(token, null, 2) + '\n', { mode: 0o600 });
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
        `OAuth client is invalid (${body.error}). Re-running auth will not help — the client ID in ${clientPath()} needs to be replaced.`,
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

export interface AuthorizeOptions {
  /** Receives the consent URL. Default prints it to the console (CLI). */
  onUrl?: (url: string) => void;
  /** Abort the flow: closes the loopback server and rejects. */
  signal?: AbortSignal;
}

/**
 * Interactive loopback flow. Surfaces the consent URL; resolves when the
 * user approves. Scope resolution: explicit argument, else the client
 * JSON's "scopes" array, else drive.file.
 */
export async function authorize(
  requestedScopes?: string[],
  options: AuthorizeOptions = {},
): Promise<TokenCache> {
  const client = await loadClient();
  const scopes = requestedScopes ?? client.scopes ?? [DRIVE_FILE_SCOPE];
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('base64url');
  const quiet = options.onUrl !== undefined;
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
    if (options.signal) {
      const onAbort = () => {
        server.close();
        reject(new Error('Authorization cancelled'));
      };
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener('abort', onAbort, { once: true });
    }
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
      if (quiet) options.onUrl!(authUrl.toString());
      else console.log(`\nOpen this URL in your browser to authorize:\n\n${authUrl.toString()}\n`);
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
  if (!quiet) {
    console.log(`Authorized. Granted scopes: ${token.scopes.join(', ')}`);
    console.log(`Token cached at ${tokenPath()}`);
  }
  return token;
}

/**
 * Access token for API calls: cached if fresh and sufficiently scoped,
 * refreshed if expired, otherwise null (callers skip — the live suite
 * must skip, not fail, when unauthenticated).
 */
export async function getAccessToken(required: string[] = [DRIVE_FILE_SCOPE]): Promise<string | null> {
  const cached = await loadToken();
  if (!cached) return null;
  if (!required.every((s) => scopeSatisfied(cached.scopes, s))) return null; // narrow token ≠ valid token
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
