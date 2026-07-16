/**
 * Small but load-bearing helpers: display width (UMISC-2), quota retry
 * (UQUOTA-*), token scope checks (UAUTH-1..3), tab-title truncation
 * (UMISC-3), doc-id extraction (UMISC-4).
 */

/**
 * Approximate visible glyph count for column sizing — distinct from
 * both code points and UTF-16 units (lesson 1). Drops variation
 * selectors, skin-tone modifiers, ZWJ, and combining marks. Known,
 * accepted over-counts: flag pairs and ZWJ sequences count per part.
 */
export function displayWidth(text: string): number {
  let count = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0xfe0f || cp === 0xfe0e) continue; // variation selectors
    if (cp >= 0x1f3fb && cp <= 0x1f3ff) continue; // skin tones
    if (cp === 0x200d) continue; // ZWJ
    if (cp >= 0x0300 && cp <= 0x036f) continue; // combining marks
    if (cp === 0x20e3) continue; // keycap combiner
    count++;
  }
  return count;
}

/** UMISC-3: truncate at the Docs 50-char tab-title limit, preferring word boundaries. */
export function truncateTabTitle(title: string, max = 50): string {
  if (title.length <= max) return title;
  const cut = title.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd();
}

/** UMISC-4: doc ID from the URL shapes users actually paste. */
export function docIdFromUrl(url: string): string | null {
  const m = /docs\.google\.com\/document\/d\/([A-Za-z0-9_-]{10,})/.exec(url);
  if (m) return m[1]!;
  if (/^[A-Za-z0-9_-]{25,}$/.test(url.trim())) return url.trim(); // bare ID
  return null;
}

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  isRetryable?: (err: unknown) => boolean;
}

const defaultRetryable = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { status?: number }).status === 429;

/**
 * UQUOTA-1..3: retry-on-429 with exponential backoff at the single
 * choke point every API call goes through (60 writes/min/user).
 * Non-429 errors raise immediately; persistent 429 raises after max.
 */
export async function withQuotaRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 3;
  const base = opts.baseDelayMs ?? 30_000;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const retryable = opts.isRetryable ?? defaultRetryable;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (!retryable(err) || attempt >= retries) throw err;
      await sleep(base * 2 ** attempt);
      attempt++;
    }
  }
}

/**
 * UAUTH-1..3: a token is valid only if its *granted* scopes cover the
 * required ones — an unexpired read-only token must not pass for
 * writes. Malformed input rejects, never crashes.
 */
export function scopesSatisfy(granted: unknown, required: string[]): boolean {
  if (!Array.isArray(granted)) return false;
  const have = new Set(granted.filter((s): s is string => typeof s === 'string'));
  return required.every((s) => have.has(s));
}
