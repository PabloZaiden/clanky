import type { RefObject } from "react";
import type { PromptTemplate } from "@/shared/prompt-templates";

interface TemplateSelectorProps {
  templates: PromptTemplate[];
  loading: boolean;
  error: string | null;
  selectedTemplate: string;
  onChange: (templateId: string) => void;
  onPromptChange: (prompt: string) => void;
  promptRef: RefObject<string>;
}

export function TemplateSelector({
  templates,
  loading,
  error,
  selectedTemplate,
  onChange,
  onPromptChange,
  promptRef,
}: TemplateSelectorProps) {
  const template = templates.find((candidate) => candidate.id === selectedTemplate);

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
        disabled={loading}
        onChange={(e) => {
          const templateId = e.target.value;
          onChange(templateId);
          if (templateId) {
            const nextTemplate = templates.find((candidate) => candidate.id === templateId);
            if (nextTemplate) {
              onPromptChange(nextTemplate.prompt);
              promptRef.current = nextTemplate.prompt;
            }
          }
        }}
        className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900 shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-300 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100 dark:focus:ring-gray-600"
      >
        <option value="">No template (custom prompt)</option>
        {templates.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
      {error ? (
        <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
          Failed to load templates: {error}
        </p>
      ) : null}
      {template ? (
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {template.description}
        </p>
      ) : null}
    </div>
  );
}
