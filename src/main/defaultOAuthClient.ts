/**
 * The OAuth client Margin ships as its default, used when the user has
 * no client file in ~/.config/gdocs-sync/ (or legacy ~/.config/margin/).
 *
 * The credentials are injected at BUILD time from the environment
 * (MARGIN_GOOGLE_OAUTH_CLIENT_ID / MARGIN_GOOGLE_OAUTH_CLIENT_SECRET,
 * via `define` in electron.vite.config.ts — locally from .env, in CI
 * from repo secrets). They are never committed: installed-app
 * credentials are not confidential in Google's OAuth model (PKCE + the
 * consent screen are the boundary, and the scope is drive.file only),
 * but keeping them out of the repo means scraping the source is not
 * enough — you'd have to extract them from a shipped binary.
 *
 * A build without the env vars gets no default; the Settings screen
 * then requires an imported client before Connect is available.
 */
declare const __MARGIN_OAUTH_CLIENT_ID__: string;
declare const __MARGIN_OAUTH_CLIENT_SECRET__: string;

const clientId = typeof __MARGIN_OAUTH_CLIENT_ID__ === 'string' ? __MARGIN_OAUTH_CLIENT_ID__ : '';
const clientSecret =
  typeof __MARGIN_OAUTH_CLIENT_SECRET__ === 'string' ? __MARGIN_OAUTH_CLIENT_SECRET__ : '';

export const DEFAULT_OAUTH_CLIENT: { clientId: string; clientSecret: string } | null =
  clientId !== '' && clientSecret !== '' ? { clientId, clientSecret } : null;
