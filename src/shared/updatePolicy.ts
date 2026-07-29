/**
 * When an available update is allowed to *interrupt* (#180).
 *
 * Split out of `updater.ts` because it is the part worth testing and the
 * only part with no Electron in it. The distinction it encodes:
 *
 * **The dialog is an interruption; the chip is a status.** Deferring
 * silences the interruption and never the status, which is what makes a
 * passive affordance and a suppressible prompt coexist without either
 * one nagging. Skipping a version is different in kind — a decision
 * about that release rather than about this moment — so it removes both.
 */

export interface UpdaterPrefs {
  /** Declined outright; this version never prompts again. */
  skippedVersion?: string;
  /** ISO timestamp of the last "Remind Me Later". */
  remindLaterAt?: string;
  /**
   * Legacy: a calendar day (YYYY-MM-DD). Read so an existing deferral is
   * honored, never written.
   *
   * Replaced because a calendar day is not a duration: "Remind Me Later"
   * at 23:50 reminded ten minutes later. Harmless while updates were
   * only checked at launch, and an annoyance the moment they are checked
   * on a timer.
   */
  remindLaterDate?: string;
}

/** How long "Remind Me Later" holds. */
export const REMIND_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Is a "Remind Me Later" still in force? */
export function remindSuppressed(prefs: UpdaterPrefs, now: number = Date.now()): boolean {
  if (prefs.remindLaterAt) {
    const at = Date.parse(prefs.remindLaterAt);
    // An unparseable timestamp is not a deferral. Failing open matters
    // more than failing quiet: the alternative is an update that can
    // never announce itself again.
    return Number.isFinite(at) && now >= at && now - at < REMIND_INTERVAL_MS;
  }
  if (prefs.remindLaterDate) {
    return prefs.remindLaterDate === new Date(now).toISOString().slice(0, 10);
  }
  return false;
}

/**
 * May an update to `version` raise a dialog on its own?
 *
 * Automatic prompts only. An explicit "Check for Updates…" is the
 * author asking, and asking overrides a deferral they made earlier —
 * otherwise the menu item is a button that does nothing.
 */
export function shouldPrompt(
  prefs: UpdaterPrefs,
  version: string,
  now: number = Date.now(),
): boolean {
  if (prefs.skippedVersion === version) return false;
  return !remindSuppressed(prefs, now);
}

/**
 * Does the chip appear? Availability is a fact, so only skipping the
 * version — a decision about the release itself — takes it away.
 */
export function shouldShowChip(prefs: UpdaterPrefs, version: string): boolean {
  return prefs.skippedVersion !== version;
}
