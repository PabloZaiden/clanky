import { useId, type ReactNode } from "react";

import { useComposerActionsMenuClose } from "./ComposerActionsMenu";
import { usePromptTemplates } from "../hooks";

interface ConversationTemplateSelectorProps {
  selectedTemplate: string;
  onChange: (templateId: string) => void;
  onPromptChange: (prompt: string) => void;
  disabled?: boolean;
  actions?: ReactNode;
}

export function ConversationTemplateSelector({
  selectedTemplate,
  onChange,
  onPromptChange,
  disabled = false,
  actions,
}: ConversationTemplateSelectorProps) {
  const templateSelectId = useId();
  const closeMenu = useComposerActionsMenuClose();
  const promptTemplates = usePromptTemplates();
  const template = promptTemplates.templates.find((item) => item.id === selectedTemplate);

  return (
    <div className="space-y-1">
      <label htmlFor={templateSelectId} className="sr-only">Template</label>
      <div className="flex items-center gap-3">
        <select
          id={templateSelectId}
          value={selectedTemplate}
          disabled={disabled || promptTemplates.loading}
          onChange={(event) => {
            const templateId = event.target.value;
            onChange(templateId);
            const nextTemplate = promptTemplates.templates.find(
              (item) => item.id === templateId,
            );
            if (nextTemplate) {
              onPromptChange(nextTemplate.prompt);
              closeMenu?.();
            }
          }}
          className="clanky-composer-field clanky-composer-select block min-w-0 flex-1 w-full rounded-md px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
        >
          <option value="">No template (custom message)</option>
          {promptTemplates.templates.map((promptTemplate) => (
            <option key={promptTemplate.id} value={promptTemplate.id}>
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
