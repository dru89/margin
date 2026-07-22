/**
 * The OAuth client Margin ships as its default, used when the user has
 * no client file in ~/.config/gdocs-sync/ (or legacy ~/.config/margin/).
 *
 * Installed-app ("Desktop") client credentials are not confidential in
 * Google's OAuth model — the app cannot keep a secret, PKCE + the
 * loopback redirect + the user-facing consent screen are the actual
 * security boundary, and the scope is drive.file only. Shipping one in
 * a public repo is established practice (rclone, gcloud). It does mean
 * shared API quota and that the client owner can see aggregate usage.
 *
 * null = no default; the Settings screen then requires an imported
 * client before Connect is available. To ship a default, paste the
 * client_id/client_secret from Google's downloaded Desktop-client JSON.
 */
export const DEFAULT_OAUTH_CLIENT: { clientId: string; clientSecret: string } | null = null;
