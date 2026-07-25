import { useEffect, useState } from 'react';
import type { ModelChoice, ModelPreference } from '@shared/types';

/**
 * Model + effort selector, driven entirely by the SDK's catalog
 * (issues #93/#86). Nothing here is hardcoded — the list, the model
 * ids, and which models even have an effort control all come from
 * `supportedModels()`.
 *
 * Shared by the toolbar, Settings, and the new-project screen so the
 * three cannot drift. Deliberately shows the wire id rather than the
 * catalog's prose description: the audience wants to know exactly
 * which weights they selected, and the description wrapped to three
 * lines and shifted the layout under it. The id sits below *both*
 * selects rather than under the model — it reads as a footnote to the
 * pair instead of breaking them apart.
 */
export function ModelPicker({
  value,
  onChange,
  /**
   * Whether "inherit from the level above" is offered. Settings sets
   * the root default, so it has nothing to inherit from — and it is
   * the one screen that offers the catalog's own "Default
   * (recommended)" row. Everywhere else that row is hidden: offering
   * both it and "Use my default" asks the user to distinguish two
   * things that only differ if Settings is unset, and anyone with an
   * opinion about the recommended model can just set it in Settings
   * (Drew's call).
   */
  allowInherit = true,
  inheritLabel = 'Use my default',
}: {
  value: ModelPreference;
  onChange: (next: ModelPreference) => void;
  allowInherit?: boolean;
  inheritLabel?: string;
}) {
  const [models, setModels] = useState<ModelChoice[]>([]);

  useEffect(() => {
    let live = true;
    window.margin
      .listModels()
      .then((m) => live && setModels(m))
      .catch(() => {
        /* leave the list empty; rounds fall back to the CLI default */
      });
    return () => {
      live = false;
    };
  }, []);

  // Without an inherit option, an unset preference means the catalog's
  // own default row.
  const current = value.model ?? (allowInherit ? '' : 'default');
  const selected = models.find((m) => m.value === current);
  const levels = selected?.effortLevels ?? [];
  const choices = allowInherit ? models.filter((m) => m.value !== 'default') : models;

  return (
    <div className="model-picker">
      <label className="model-row">
        <span className="model-label">Model</span>
        <select
          className="model-select"
          value={current}
          onChange={(e) => {
            const model = e.target.value || undefined;
            // Effort belongs to a model: drop a level the new model
            // doesn't offer rather than sending one it would reject.
            const next = models.find((m) => m.value === model);
            const keep = value.effort && next?.effortLevels.includes(value.effort);
            onChange({ model, effort: keep ? value.effort : undefined });
          }}
        >
          {allowInherit && <option value="">{inheritLabel}</option>}
          {choices.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </label>

      {levels.length > 0 && (
        <label className="model-row">
          <span className="model-label">Effort</span>
          <select
            className="model-select"
            value={value.effort ?? ''}
            onChange={(e) => onChange({ ...value, effort: e.target.value || undefined })}
          >
            <option value="">Default</option>
            {levels.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </label>
      )}

      {selected?.resolvedModel && (
        <div className="model-row">
          <span className="model-label" />
          <code className="model-id">{selected.resolvedModel}</code>
        </div>
      )}
    </div>
  );
}
