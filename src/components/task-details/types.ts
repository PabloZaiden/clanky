import type { ModelConfig } from "../../types/task";

export type TabId = "log" | "chat" | "info" | "prompt" | "plan" | "diff" | "actions";

export const tabs: { id: TabId; label: string }[] = [
  { id: "log", label: "Log" },
  { id: "chat", label: "Chat" },
  { id: "info", label: "Info" },
  { id: "prompt", label: "Prompt" },
  { id: "plan", label: "Plan" },
  { id: "diff", label: "Diff" },
  { id: "actions", label: "Actions" },
];

/**
 * Format a timestamp for display.
 */
export function formatDateTime(isoString: string | undefined): string {
  if (!isoString) return "N/A";
  return new Date(isoString).toLocaleString();
}

/**
 * Format model configuration for display.
 * Shows providerID/modelID, with variant in parentheses if present.
 */
export function formatModelDisplay(model: ModelConfig | undefined): string {
  if (!model) return "Not configured";
  const base = `${model.providerID}/${model.modelID}`;
  if (model.variant && model.variant.trim() !== "") {
    return `${base} (${model.variant})`;
  }
  return base;
}
