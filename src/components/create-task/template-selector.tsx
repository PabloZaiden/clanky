import type { RefObject } from "react";
import { PROMPT_TEMPLATES, getTemplateById } from "../../lib/prompt-templates";

interface TemplateSelectorProps {
  selectedTemplate: string;
  onChange: (templateId: string) => void;
  onPromptChange: (prompt: string) => void;
  onPlanModeChange: (planMode: boolean) => void;
  promptRef: RefObject<string>;
}

export function TemplateSelector({
  selectedTemplate,
  onChange,
  onPromptChange,
  onPlanModeChange,
  promptRef,
}: TemplateSelectorProps) {
  return (
    <div>
      <label
        htmlFor="template"
        className="block text-sm font-medium text-gray-700 dark:text-gray-300"
      >
        Template
      </label>
      <select
        id="template"
        value={selectedTemplate}
        onChange={(e) => {
          const templateId = e.target.value;
          onChange(templateId);
          if (templateId) {
            const template = getTemplateById(templateId);
            if (template) {
              onPromptChange(template.prompt);
              promptRef.current = template.prompt;
              if (template.taskDefaults?.planMode !== undefined) {
                onPlanModeChange(template.taskDefaults.planMode);
              }
            }
          }
        }}
        className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900 shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-300 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100 dark:focus:ring-gray-600"
      >
        <option value="">No template (custom prompt)</option>
        {PROMPT_TEMPLATES.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
      {selectedTemplate && (() => {
        const t = getTemplateById(selectedTemplate);
        return t ? (
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {t.description}
          </p>
        ) : null;
      })()}
    </div>
  );
}
