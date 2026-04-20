/**
 * Shared ModelSelector component for selecting AI models.
 *
 * Extracts duplicated model grouping, sorting, and option rendering logic
 * from CreateLoopForm and LoopActionBar into a reusable component.
 */

import type { ModelInfo } from "../types";

// ─── Shared model utilities ───────────────────────────────────────────────────

/** Build a model key string from provider, model, and variant. */
export function makeModelKey(providerID: string, modelID: string, variant?: string): string {
  return `${providerID}:${modelID}:${variant ?? ""}`;
}

/** Parse a model key string into its parts. */
export function parseModelKey(key: string): { providerID: string; modelID: string; variant: string } | null {
  const parts = key.split(":");
  if (parts.length < 2 || !parts[0] || !parts[1]) return null;
  return {
    providerID: parts[0],
    modelID: parts[1],
    variant: parts.length >= 3 ? parts.slice(2).join(":") : "",
  };
}

/** Check if a model with the given key is connected. */
export function isModelEnabled(models: ModelInfo[], modelKey: string): boolean {
  if (!modelKey) return false;
  const parsed = parseModelKey(modelKey);
  if (!parsed) return false;
  const model = models.find((m) => m.providerID === parsed.providerID && m.modelID === parsed.modelID);
  return model?.connected ?? false;
}

/** Get display name for a model key. */
export function getModelDisplayName(models: ModelInfo[], modelKey: string): string {
  if (!modelKey) return "Default";
  const parsed = parseModelKey(modelKey);
  if (!parsed) return "Unknown";
  const model = models.find((m) => m.providerID === parsed.providerID && m.modelID === parsed.modelID);
  const baseName = model?.modelName ?? parsed.modelID ?? "Unknown";
  return parsed.variant ? `${baseName} (${parsed.variant})` : baseName;
}

/** Check if a specific model+variant combination exists in the models list. */
export function modelVariantExists(
  models: ModelInfo[],
  providerID: string,
  modelID: string,
  variant: string,
): boolean {
  const model = models.find((m) => m.providerID === providerID && m.modelID === modelID);
  if (!model) return false;
  if (!model.variants || model.variants.length === 0) {
    return variant === "";
  }
  return model.variants.includes(variant);
}

// ─── Model grouping/sorting ──────────────────────────────────────────────────

interface GroupedModels {
  /** Models grouped by provider name. */
  modelsByProvider: Record<string, ModelInfo[]>;
  /** Provider names that have at least one connected model, sorted alphabetically. */
  connectedProviders: string[];
  /** Provider names where no models are connected, sorted alphabetically. */
  disconnectedProviders: string[];
}

/** Group models by provider, sort within each group, and classify providers. */
export function groupModelsByProvider(models: ModelInfo[]): GroupedModels {
  const modelsByProvider = models.reduce<Record<string, ModelInfo[]>>(
    (acc, model) => {
      const key = model.providerName;
      if (!acc[key]) {
        acc[key] = [];
      }
      acc[key].push(model);
      return acc;
    },
    {},
  );

  // Sort models within each provider by name
  for (const provider of Object.keys(modelsByProvider)) {
    const providerModels = modelsByProvider[provider];
    if (providerModels) {
      providerModels.sort((a, b) => a.modelName.localeCompare(b.modelName));
    }
  }

  const connectedProviders = Object.keys(modelsByProvider)
    .filter((provider) => {
      const providerModels = modelsByProvider[provider];
      return providerModels && providerModels.some((m) => m.connected);
    })
    .sort((a, b) => a.localeCompare(b));

  const disconnectedProviders = Object.keys(modelsByProvider)
    .filter((provider) => {
      const providerModels = modelsByProvider[provider];
      return providerModels && !providerModels.some((m) => m.connected);
    })
    .sort((a, b) => a.localeCompare(b));

  return { modelsByProvider, connectedProviders, disconnectedProviders };
}

// ─── Option rendering ────────────────────────────────────────────────────────

interface RenderModelOptionsConfig {
  /** Whether to disable all options in this group (e.g., disconnected provider). */
  disabled?: boolean;
  /** Model key to mark as "(current)" and disable. */
  currentModelKey?: string;
}

/**
 * Render <option> elements for a model, expanding variants into separate options.
 * For models without variants, renders a single option.
 * For models with variants, renders one option per variant.
 */
export function renderModelOptions(
  model: ModelInfo,
  config: RenderModelOptionsConfig = {},
) {
  const { disabled = false, currentModelKey } = config;
  const variants =
    model.variants && model.variants.length > 0
      ? model.variants
      : [""]; // No variants = single option with empty variant

  // Sort variants: empty string first, then alphabetically
  const sortedVariants = [...variants].sort((a, b) => {
    if (a === "") return -1;
    if (b === "") return 1;
    return a.localeCompare(b);
  });

  return sortedVariants.map((variant) => {
    const optionValue = makeModelKey(model.providerID, model.modelID, variant);
    const displayName = variant
      ? `${model.modelName} (${variant})`
      : model.modelName;
    const isCurrent = currentModelKey ? optionValue === currentModelKey : false;

    return (
      <option
        key={optionValue}
        value={optionValue}
        disabled={disabled || isCurrent}
      >
        {displayName}
        {isCurrent ? " (current)" : ""}
      </option>
    );
  });
}

// ─── ModelSelector component ─────────────────────────────────────────────────

export interface ModelSelectorProps {
  /** Currently selected model key (providerID:modelID:variant). */
  value: string;
  /** Callback when model selection changes. */
  onChange: (modelKey: string) => void;
  /** Available models. */
  models: ModelInfo[];
  /** Whether models are loading. */
  loading?: boolean;
  /** Whether the selector is disabled. */
  disabled?: boolean;
  /** Show disconnected providers (with disabled options). */
  showDisconnected?: boolean;
  /** Current model key to mark as "(current)" in the list. */
  currentModelKey?: string;
  /** Placeholder shown when no model is selected. */
  placeholder?: string;
  /** Extra options rendered before provider groups. */
  additionalOptions?: Array<{
    value: string;
    label: string;
    disabled?: boolean;
  }>;
  /** Text shown while loading. */
  loadingText?: string;
  /** Text shown when no models are available. */
  emptyText?: string;
  /** Additional CSS classes for the select element. */
  className?: string;
  /** HTML id attribute. */
  id?: string;
  /** Render a compact square trigger on mobile while keeping the full select on larger screens. */
  compactMobile?: boolean;
  /** Label shown inside the compact mobile trigger. */
  compactMobileLabel?: string;
}

export function ModelSelector({
  value,
  onChange,
  models,
  loading = false,
  disabled = false,
  showDisconnected = false,
  currentModelKey,
  placeholder = "Select a model...",
  additionalOptions = [],
  loadingText = "Loading models...",
  emptyText = "Select a workspace to load models",
  className = "",
  id,
  compactMobile = false,
  compactMobileLabel = "AI",
}: ModelSelectorProps) {
  const { modelsByProvider, connectedProviders, disconnectedProviders } =
    groupModelsByProvider(models);
  const hasOptions = additionalOptions.length > 0 || models.length > 0;

  const select = (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled || loading || !hasOptions}
      className={compactMobile
        ? `absolute inset-0 h-full w-full opacity-0 sm:static sm:inset-auto sm:opacity-100 ${className}`
        : className}
    >
      {loading && <option value="">{loadingText}</option>}
      {!loading && !hasOptions && <option value="">{emptyText}</option>}
      {!loading && models.length > 0 && (
        <>
          <option value="">{placeholder}</option>
          {additionalOptions.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
          {connectedProviders.map((provider) => {
            const providerModels = modelsByProvider[provider] ?? [];
            return (
              <optgroup key={provider} label={provider}>
                {providerModels.map((model) =>
                  renderModelOptions(model, { currentModelKey }),
                )}
              </optgroup>
            );
          })}
          {showDisconnected &&
            disconnectedProviders.map((provider) => {
              const providerModels = modelsByProvider[provider] ?? [];
              return (
                <optgroup
                  key={provider}
                  label={`${provider} (not connected)`}
                >
                  {providerModels.map((model) =>
                    renderModelOptions(model, { disabled: true, currentModelKey }),
                  )}
                </optgroup>
              );
            })}
          {connectedProviders.length === 0 && (
            <option value="" disabled>
              No connected providers available
            </option>
          )}
        </>
      )}
      {!loading && models.length === 0 && additionalOptions.length > 0 && (
        <>
          <option value="">{placeholder}</option>
          {additionalOptions.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
        </>
      )}
    </select>
  );

  if (!compactMobile) {
    return select;
  }

  return (
    <div className="relative h-9 w-9 shrink-0 sm:h-auto sm:w-auto">
      {select}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-md border border-gray-300 bg-white text-[11px] font-semibold text-gray-700 shadow-sm dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-200 sm:hidden"
      >
        {compactMobileLabel}
      </div>
    </div>
  );
}
