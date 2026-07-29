#!/usr/bin/env node
/**
 * When an available update may interrupt (#180).
 *
 * The rule this suite protects: **the dialog is an interruption and the
 * chip is a status.** Deferring silences the first and never the second,
 * which is what lets a periodic check exist without nagging. Skipping is
 * a decision about the release, so it silences both.
 *
 * And the bug that prompted it: "Remind Me Later" stored a *calendar
 * day*, so clicking it at 23:50 deferred for ten minutes. Harmless while
 * updates were only checked at launch; an annoyance the moment they are
 * checked every six hours.
 *
 *   node scripts/test-update-policy.mjs
 */
import { rmSync } from 'fs';
import { load, reporter } from './lib/compile.mjs';

const { mod, dir: build } = await load('src/shared/updatePolicy.ts');
const { remindSuppressed, shouldPrompt, shouldShowChip, REMIND_INTERVAL_MS } = mod;
const { t, head, done } = reporter();

const HOUR = 60 * 60 * 1000;
const at = (iso) => Date.parse(iso);

head('"Remind Me Later" is a duration, not a date');
// The failure that started this: 23:50 + ten minutes crossed midnight,
// the stored calendar day stopped matching, and the prompt came back.
const lateNight = '2026-07-27T23:50:00.000Z';
t('ten minutes after a late-night defer',
  remindSuppressed({ remindLaterAt: lateNight }, at('2026-07-28T00:00:00.000Z')), true);
t('an hour after', remindSuppressed({ remindLaterAt: lateNight }, at('2026-07-28T00:50:00.000Z')), true);
t('23 hours after', remindSuppressed({ remindLaterAt: lateNight }, at(lateNight) + 23 * HOUR), true);
// It has to end, or one deferral silences updates forever.
t('25 hours after', remindSuppressed({ remindLaterAt: lateNight }, at(lateNight) + 25 * HOUR), false);
t('exactly at the boundary', remindSuppressed({ remindLaterAt: lateNight }, at(lateNight) + REMIND_INTERVAL_MS), false);
t('the moment it was set', remindSuppressed({ remindLaterAt: lateNight }, at(lateNight)), true);

head('the legacy calendar-day pref is still honored');
// Someone upgrading has one of these on disk; it is read, never written.
t('same day', remindSuppressed({ remindLaterDate: '2026-07-27' }, at('2026-07-27T12:00:00.000Z')), true);
t('the next day', remindSuppressed({ remindLaterDate: '2026-07-27' }, at('2026-07-28T00:01:00.000Z')), false);
// The new field wins when both are present, since it is what gets written.
t('the new field takes precedence',
  remindSuppressed({ remindLaterAt: lateNight, remindLaterDate: '2020-01-01' }, at(lateNight) + HOUR), true);

head('a broken pref fails open');
// Failing quiet would mean an update that can never announce itself.
t('unparseable timestamp', remindSuppressed({ remindLaterAt: 'whenever' }, Date.now()), false);
t('no preferences at all', remindSuppressed({}, Date.now()), false);
t('a timestamp from the future', remindSuppressed({ remindLaterAt: '2099-01-01T00:00:00.000Z' }, at(lateNight)), false);

head('skipping a version');
t('the skipped version never prompts', shouldPrompt({ skippedVersion: '0.6.0' }, '0.6.0'), false);
// Skipping 0.6.0 says nothing about 0.6.1.
t('a later version still does', shouldPrompt({ skippedVersion: '0.6.0' }, '0.6.1'), true);

head('the chip outlives the deferral');
// The whole reason a periodic check is safe: deferring stops the
// interruption without hiding the fact that an update exists.
const deferred = { remindLaterAt: new Date().toISOString() };
t('no prompt while deferred', shouldPrompt(deferred, '0.6.0'), false);
t('but the chip stays', shouldShowChip(deferred, '0.6.0'), true);
// Skipping is a decision about the release, so it takes the chip too.
t('skipping removes the chip', shouldShowChip({ skippedVersion: '0.6.0' }, '0.6.0'), false);
t('and only for that version', shouldShowChip({ skippedVersion: '0.6.0' }, '0.6.1'), true);

rmSync(build, { recursive: true, force: true });
done('update-policy');
