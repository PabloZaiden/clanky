import type { ChangeEvent } from "react";
import type { UploadedPlanFile } from "./types";

interface UploadedPlanFieldProps {
  uploadedPlan: UploadedPlanFile | null;
  error: string | null;
  onUploadedPlanChange: (plan: UploadedPlanFile | null) => void;
  onErrorChange: (error: string | null) => void;
  disabled?: boolean;
}

export function UploadedPlanField({
  uploadedPlan,
  error,
  onUploadedPlanChange,
  onErrorChange,
  disabled = false,
}: UploadedPlanFieldProps) {
  async function handleFileChange(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) {
      return;
    }

    try {
      const planContent = await file.text();
      if (!planContent.trim()) {
        onUploadedPlanChange(null);
        onErrorChange("Choose a plan file with content.");
        return;
      }

      onUploadedPlanChange({
        fileName: file.name,
        planContent,
      });
      onErrorChange(null);
    } catch (readError) {
      onUploadedPlanChange(null);
      onErrorChange(`Failed to read plan file: ${String(readError)}`);
    }
  }

  return (
    <div className="rounded-md border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-neutral-800/60">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <label
            htmlFor="uploaded-plan"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300"
          >
            Start from an existing plan
          </label>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Upload a completed plan file to skip plan generation and start implementation from it.
          </p>
        </div>
        <label className="inline-flex shrink-0 cursor-pointer items-center justify-center rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-200 dark:hover:bg-neutral-600">
          Upload plan
          <input
            id="uploaded-plan"
            type="file"
            accept=".md,.markdown,text/markdown,text/plain"
            onChange={(event) => void handleFileChange(event)}
            disabled={disabled}
            className="sr-only"
          />
        </label>
      </div>

      {uploadedPlan && (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-900/20 dark:text-emerald-200">
          <span className="truncate">Selected: {uploadedPlan.fileName}</span>
          <button
            type="button"
            onClick={() => {
              onUploadedPlanChange(null);
              onErrorChange(null);
            }}
            className="shrink-0 text-xs font-medium text-emerald-800 underline hover:text-emerald-950 dark:text-emerald-200 dark:hover:text-emerald-100"
          >
            Remove
          </button>
        </div>
      )}

      {error && (
        <p className="mt-2 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
