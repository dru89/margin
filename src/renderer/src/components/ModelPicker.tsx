import { useEffect, useState } from 'react';
import type { ModelChoice, ModelPreference } from '@shared/types';

/**
 * Model + effort selector, driven entirely by the SDK's catalog
 * (issues #93/#86). Nothing here is hardcoded — the list, the version
 * strings, and which models even have an effort control all come from
 * `supportedModels()`.
 *
 * Shared by the toolbar (per-project choice), Settings (the app
 * default), and the new-project screen, so the three stay consistent.
 */
export function ModelPicker({
  value,
  onChange,
  /** Label for "inherit from the level above" (empty value). */
  inheritLabel,
}: {
  value: ModelPreference;
  onChange: (next: ModelPreference) => void;
  inheritLabel: string;
}) {
  const [models, setModels] = useState<ModelChoice[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let live = true;
    window.margin
      .listModels()
      .then((m) => live && setModels(m))
      .catch(() => live && setError(true));
    return () => {
      live = false;
    };
  }, []);

  const selected = models?.find((m) => m.value === value.model);
  const levels = selected?.effortLevels ?? [];

  return (
    <div className="model-picker">
      <label className="model-row">
        Model
        <select
          value={value.model ?? ''}
          disabled={models === null && !error}
          onChange={(e) => {
            const model = e.target.value || undefined;
            // Effort belongs to a model; drop it when the new model
            // has no effort control (Haiku) or when inheriting.
            const next = models?.find((m) => m.value === model);
            const keep = model && next?.effortLevels.includes(value.effort ?? '');
            onChange({ model, effort: keep ? value.effort : undefined });
          }}
        >
          <option value="">{inheritLabel}</option>
          {models?.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </label>

      {selected && (
        <p className="model-detail">
          {selected.description}
          {selected.resolvedModel && <code className="model-id">{selected.resolvedModel}</code>}
        </p>
      )}

      {levels.length > 0 && (
        <label className="model-row">
          Effort
          <select
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

      {models === null && !error && <p className="model-detail">Loading models…</p>}
      {error && (
        <p className="model-detail">
          Couldn’t read the model list. Rounds will use the Claude Code default.
        </p>
      )}
    </div>
  );
}
