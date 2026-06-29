/**
 * Shared ModelSelector component for selecting AI models.
 *
 * Extracts duplicated model grouping, sorting, and option rendering logic
 * from CreateTaskForm and TaskActionBar into a reusable component.
 */

import { useEffect, useMemo } from "react";
import type { ModelInfo } from "../types";
import { useModelVariants } from "../hooks/useModelVariants";

// ─── Shared model utilities ───────────────────────────────────────────────────

const REASONING_EFFORT_ORDER = new Map([
  ["low", 0],
  ["medium", 1],
  ["high", 2],
  ["xhigh", 3],
]);

/** Build a model key string from provider, model, and variant. */
export function makeModelKey(providerID: string, modelID: string, variant?: string): string {
  return `${providerID}:${modelID}:${variant ?? ""}`;
}

function makeModelBaseKey(providerID: string, modelID: string): string {
  return `${providerID}:${modelID}`;
}

function parseModelBaseKey(key: string): { providerID: string; modelID: string } | null {
  const parts = key.split(":");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return {
    providerID: parts[0],
    modelID: parts[1],
  };
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
    return true;
  }
  return model.variants.includes(variant);
}

export function sortModelVariants(variants: readonly string[]): string[] {
  return [...variants].sort((a, b) => {
    const aOrder = REASONING_EFFORT_ORDER.get(a);
    const bOrder = REASONING_EFFORT_ORDER.get(b);

    if (aOrder !== undefined && bOrder !== undefined) {
      return aOrder - bOrder;
    }
    if (aOrder !== undefined) {
      return -1;
    }
    if (bOrder !== undefined) {
      return 1;
    }
    return a.localeCompare(b);
  });
}

export function getPreferredModelVariant(
  models: ModelInfo[],
  providerID: string,
  modelID: string,
  variant: string,
): string | null {
  const model = models.find((entry) => entry.providerID === providerID && entry.modelID === modelID);
  if (!model) {
    return null;
  }
  if (!model.variants || model.variants.length === 0) {
    return variant;
  }
  if (model.variants.includes(variant)) {
    return variant;
  }
  return model.variants[0] ?? null;
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
 * Render a model <option>. Variants are selected separately by ModelSelector.
 */
export function renderModelOptions(
  model: ModelInfo,
  config: RenderModelOptionsConfig = {},
) {
  const { disabled = false, currentModelKey } = config;
  const optionValue = makeModelBaseKey(model.providerID, model.modelID);
  const current = currentModelKey ? parseModelKey(currentModelKey) : null;
  const isCurrent = current
    ? current.providerID === model.providerID && current.modelID === model.modelID
    : false;

  return (
    <option
      key={optionValue}
      value={optionValue}
      disabled={disabled}
    >
      {model.modelName}
      {isCurrent ? " (current)" : ""}
    </option>
  );
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
  /** Accessible name applied directly to the select when no external label is used. */
  ariaLabel?: string;
  /** Render the selector as a compact square trigger across breakpoints. */
  compact?: boolean;
  /** Label shown inside the compact trigger. */
  compactLabel?: string;
  /** Workspace context for lazy per-model variant discovery. */
  variantDiscovery?: {
    directory: string;
    workspaceId: string;
  };
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
  ariaLabel,
  compact = false,
  compactLabel = "AI",
  variantDiscovery,
}: ModelSelectorProps) {
  const parsedValue = useMemo(() => parseModelKey(value), [value]);
  const selectedModel = useMemo(() => {
    if (!parsedValue) {
      return null;
    }
    return models.find((model) =>
      model.providerID === parsedValue.providerID
      && model.modelID === parsedValue.modelID
    ) ?? null;
  }, [models, parsedValue]);

  const knownVariants = selectedModel?.variants && selectedModel.variants.length > 0
    ? sortModelVariants(selectedModel.variants)
    : [];
  const shouldDiscoverVariants = Boolean(
    variantDiscovery
    && selectedModel
    && selectedModel.connected
    && knownVariants.length === 0
    && parsedValue,
  );
  const { variants: discoveredVariants, variantsLoading } = useModelVariants({
    directory: variantDiscovery?.directory,
    workspaceId: variantDiscovery?.workspaceId,
    modelID: parsedValue?.modelID,
    enabled: shouldDiscoverVariants,
  });

  const variantOptions = useMemo(() => {
    const source = knownVariants.length > 0
      ? knownVariants
      : discoveredVariants.length > 0 ? discoveredVariants : [];
    const variants = parsedValue?.variant && !source.includes(parsedValue.variant)
      ? [parsedValue.variant, ...source]
      : source;
    return sortModelVariants([...new Set(variants)]);
  }, [discoveredVariants, knownVariants, parsedValue]);

  useEffect(() => {
    if (!parsedValue || !selectedModel || variantsLoading || variantOptions.length === 0) {
      return;
    }
    const preferredVariant = variantOptions.includes(parsedValue.variant)
      ? parsedValue.variant
      : variantOptions[0] ?? "";
    if (preferredVariant !== parsedValue.variant) {
      onChange(makeModelKey(parsedValue.providerID, parsedValue.modelID, preferredVariant));
    }
  }, [onChange, parsedValue, selectedModel, variantOptions, variantsLoading]);

  const { modelsByProvider, connectedProviders, disconnectedProviders } =
    groupModelsByProvider(models);
  const hasOptions = additionalOptions.length > 0 || models.length > 0;
  const isSelectDisabled = disabled || loading || !hasOptions;
  const selectedModelBaseKey = parsedValue && selectedModel
    ? makeModelBaseKey(parsedValue.providerID, parsedValue.modelID)
    : value;
  const hasVariantChoices = variantOptions.some((variant) => variant !== "");
  const showVariantSelect = Boolean(selectedModel && (variantsLoading || hasVariantChoices));
  const selectedVariantValue = variantOptions.includes(parsedValue?.variant ?? "")
    ? parsedValue?.variant ?? ""
    : variantOptions[0] ?? "";

  function handleModelChange(modelValue: string): void {
    if (!modelValue) {
      onChange("");
      return;
    }

    const parsedModel = parseModelBaseKey(modelValue);
    if (!parsedModel) {
      onChange(modelValue);
      return;
    }

    const model = models.find((entry) =>
      entry.providerID === parsedModel.providerID
      && entry.modelID === parsedModel.modelID
    );
    if (!model) {
      onChange(modelValue);
      return;
    }

    const variants = model.variants && model.variants.length > 0
      ? sortModelVariants(model.variants)
      : [];
    onChange(makeModelKey(model.providerID, model.modelID, variants[0] ?? ""));
  }

  function handleVariantChange(variant: string): void {
    if (!parsedValue || !selectedModel) {
      return;
    }
    onChange(makeModelKey(parsedValue.providerID, parsedValue.modelID, variant));
  }

  const modelSelect = (
    <select
      id={id}
      aria-label={ariaLabel}
      value={selectedModelBaseKey}
      onChange={(e) => handleModelChange(e.target.value)}
      disabled={isSelectDisabled}
      className={compact
        ? `peer absolute inset-0 h-full w-full opacity-0 ${className}`
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

  const variantSelect = showVariantSelect ? (
    <select
      id={id ? `${id}-variant` : undefined}
      aria-label={ariaLabel ? `${ariaLabel} variant` : "Model variant"}
      value={selectedVariantValue}
      onChange={(e) => handleVariantChange(e.target.value)}
      disabled={disabled || loading || variantsLoading}
      className={compact
        ? `peer absolute inset-0 h-full w-full opacity-0 ${className}`
        : className}
    >
      {variantsLoading && <option value={selectedVariantValue}>Loading variants...</option>}
      {!variantsLoading && variantOptions.map((variant) => {
        const variantValue = variant;
        const current = currentModelKey ? parseModelKey(currentModelKey) : null;
        const isCurrent = current
          ? current.providerID === parsedValue?.providerID
            && current.modelID === parsedValue?.modelID
            && current.variant === variantValue
          : false;
        return (
          <option
            key={variantValue}
            value={variantValue}
            disabled={isCurrent}
          >
            {variantValue || "Default"}
            {isCurrent ? " (current)" : ""}
          </option>
        );
      })}
    </select>
  ) : null;

  if (!compact) {
    if (!variantSelect) {
      return modelSelect;
    }
    return (
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(8rem,0.45fr)]">
        {modelSelect}
        {variantSelect}
      </div>
    );
  }

  const compactButtonClassName = "pointer-events-none absolute inset-0 flex items-center justify-center rounded-md border border-gray-300 bg-white text-[11px] font-semibold text-gray-700 shadow-sm transition peer-disabled:border-gray-200 peer-disabled:bg-gray-100 peer-disabled:text-gray-400 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-200 dark:peer-disabled:border-gray-700 dark:peer-disabled:bg-neutral-800 dark:peer-disabled:text-gray-500 peer-focus-visible:border-gray-500 peer-focus-visible:ring-2 peer-focus-visible:ring-gray-300 dark:peer-focus-visible:border-gray-500 dark:peer-focus-visible:ring-gray-500";

  return (
    <div className="flex shrink-0 gap-1">
      <div className="relative h-9 w-9 shrink-0">
        {modelSelect}
        <div aria-hidden="true" className={compactButtonClassName}>
          {compactLabel}
        </div>
      </div>
      {variantSelect && (
        <div className="relative h-9 w-9 shrink-0">
          {variantSelect}
          <div aria-hidden="true" className={compactButtonClassName}>
            V
          </div>
        </div>
      )}
    </div>
  );
}
