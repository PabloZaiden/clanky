import type { ModelInfo } from "../../types";
import { ModelSelector, groupModelsByProvider } from "../ModelSelector";

interface ModelFieldProps {
  selectedModel: string;
  onChange: (model: string) => void;
  models: ModelInfo[];
  modelsLoading: boolean;
}

export function ModelField({ selectedModel, onChange, models, modelsLoading }: ModelFieldProps) {
  return (
    <div>
      <label
        htmlFor="model"
        className="block text-sm font-medium text-gray-700 dark:text-gray-300"
      >
        Model
      </label>
      <ModelSelector
        id="model"
        value={selectedModel}
        onChange={onChange}
        models={models}
        loading={modelsLoading}
        className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900 shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-300 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100 dark:focus:ring-gray-600 disabled:opacity-50"
      />
      {!modelsLoading && models.length > 0 && groupModelsByProvider(models).connectedProviders.length === 0 && (
        <p className="mt-1 text-xs text-red-600 dark:text-red-400">
          No providers are connected. Please configure your agent backend credentials/settings.
        </p>
      )}
      {!modelsLoading && models.length > 0 && groupModelsByProvider(models).connectedProviders.length > 0 && !selectedModel && (
        <p className="mt-1 text-xs text-red-600 dark:text-red-400">
          Model is required. Please select a model.
        </p>
      )}
    </div>
  );
}
