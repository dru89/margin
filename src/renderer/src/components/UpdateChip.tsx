import { useStore } from '@/store';

/**
 * The update affordance (#180).
 *
 * **A status, not a notification.** Margin re-checks for updates every
 * few hours now, and the one thing that must not follow from that is a
 * dialog appearing over someone's writing — `update-available` re-fires
 * on every check, so a timer wired to a modal would interrupt on a loop.
 * This chip is what the timer moves instead: it waits, it does not
 * announce, and the dialog only opens when it is clicked.
 *
 * Which is also why "Remind Me Later" does not hide it. Deferring
 * silences the interruption; the update still exists. Skipping a version
 * is a decision about the release rather than about this moment, and
 * that does remove the chip.
 *
 * The `ready` state is the one that had no surface at all before:
 * declining the restart left a downloaded update sitting on disk with
 * nothing to say so, and the app running the old version indefinitely.
 */
export function UpdateChip() {
  const update = useStore((s) => s.update);
  if (update.status === 'idle') return null;

  const downloading = update.status === 'downloading';
  const ready = update.status === 'ready';
  const percent = update.percent ?? 0;

  const label = ready
    ? 'Restart to update'
    : downloading
      ? `Downloading… ${percent}%`
      : `Update ${update.version}`;

  const title = ready
    ? `Version ${update.version} is downloaded and will install when you restart.`
    : downloading
      ? `Downloading version ${update.version}.`
      : `Version ${update.version} is available. Click to see what happens next.`;

  return (
    <button
      className={`status-chip update-chip${ready ? ' update-ready' : ''}`}
      title={title}
      disabled={downloading}
      // The fill tracks the download rather than adding a second element
      // for it; at 0% it is invisible, which is the right start.
      style={downloading ? ({ '--update-progress': `${percent}%` } as React.CSSProperties) : undefined}
      onClick={() => void window.margin.updateAction()}
    >
      {!downloading && <span className="update-dot" />}
      {label}
    </button>
  );
}
