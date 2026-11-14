import { useId, type ReactNode } from "react";

import { useComposerActionsMenuClose } from "./ComposerActionsMenu";
import { usePromptTemplates } from "../hooks";
import { getOrderedPromptTemplates, PREPARE_PLAN_TEMPLATE } from "@/shared/prompt-templates";

interface ConversationTemplateSelectorProps {
  selectedTemplate: string;
  onChange: (templateValue: string) => void;
  onPromptChange: (prompt: string) => void;
  currentPrompt: string;
  disabled?: boolean;
  actions?: ReactNode;
}

export function ConversationTemplateSelector({
  selectedTemplate,
  onChange,
  onPromptChange,
  currentPrompt,
  disabled = false,
  actions,
}: ConversationTemplateSelectorProps) {
  const templateSelectId = useId();
  const closeMenu = useComposerActionsMenuClose();
  const promptTemplates = usePromptTemplates();
  const templates = getOrderedPromptTemplates(promptTemplates)
    .filter((item) => promptTemplates.planningTemplateEnabled || item.value !== PREPARE_PLAN_TEMPLATE.id);
  const template = templates.find((item) => item.value === selectedTemplate)?.template;

  return (
    <div className="space-y-1">
      <label htmlFor={templateSelectId} className="sr-only">Template</label>
      <div className="flex items-center gap-3">
        <select
          id={templateSelectId}
          value={template ? selectedTemplate : ""}
          disabled={disabled || promptTemplates.loading}
          onChange={(event) => {
            const templateValue = event.target.value;
            onChange(templateValue);
            const nextTemplate = templates.find(
              (item) => item.value === templateValue,
            );
            if (nextTemplate) {
              onPromptChange(nextTemplate.value === PREPARE_PLAN_TEMPLATE.id && currentPrompt.length > 0
                ? `${nextTemplate.template.prompt}\n\n${currentPrompt}`
                : nextTemplate.template.prompt);
              closeMenu?.();
            }
          }}
          className="clanky-composer-field clanky-composer-select block min-w-0 flex-1 w-full rounded-md px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
        >
          <option value="">No template (custom message)</option>
          {templates.map(({ value, template: promptTemplate }) => (
            <option key={value} value={value}>
              {promptTemplate.name}
            </option>
          ))}
        </select>
        {actions}
      </div>
      {promptTemplates.error ? (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          Failed to load templates: {promptTemplates.error}
        </p>
      ) : null}
      {template && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {template.description}
        </p>
      )}
    </div>
  );
}
