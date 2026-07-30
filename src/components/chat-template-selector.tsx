import { useId } from "react";

import { PROMPT_TEMPLATES, getTemplateById } from "../lib/prompt-templates";

interface ChatTemplateSelectorProps {
  selectedTemplate: string;
  onChange: (templateId: string) => void;
  onPromptChange: (prompt: string) => void;
  disabled?: boolean;
}

export function ChatTemplateSelector({
  selectedTemplate,
  onChange,
  onPromptChange,
  disabled = false,
}: ChatTemplateSelectorProps) {
  const templateSelectId = useId();
  const template = selectedTemplate ? getTemplateById(selectedTemplate) : undefined;

  return (
    <div className="space-y-1">
      <label htmlFor={templateSelectId} className="sr-only">Template</label>
      <select
        id={templateSelectId}
        value={selectedTemplate}
        onChange={(event) => {
          const templateId = event.target.value;
          onChange(templateId);
          const nextTemplate = templateId ? getTemplateById(templateId) : undefined;
          if (nextTemplate) {
            onPromptChange(nextTemplate.prompt);
          }
        }}
        disabled={disabled}
        className="clanky-composer-field clanky-composer-select block w-full rounded-md px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
      >
        <option value="">No template (custom message)</option>
        {PROMPT_TEMPLATES.map((promptTemplate) => (
          <option key={promptTemplate.id} value={promptTemplate.id}>
            {promptTemplate.name}
          </option>
        ))}
      </select>
      {template && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {template.description}
        </p>
      )}
    </div>
  );
}
