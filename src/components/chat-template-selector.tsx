import { CHAT_PROMPT_TEMPLATES, getChatTemplateById } from "../lib/chat-prompt-templates";

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
  const template = selectedTemplate ? getChatTemplateById(selectedTemplate) : undefined;

  return (
    <div className="space-y-1">
      <label htmlFor="chat-template" className="sr-only">Template</label>
      <select
        id="chat-template"
        value={selectedTemplate}
        onChange={(event) => {
          const templateId = event.target.value;
          onChange(templateId);
          const nextTemplate = templateId ? getChatTemplateById(templateId) : undefined;
          if (nextTemplate) {
            onPromptChange(nextTemplate.prompt);
          }
        }}
        disabled={disabled}
        className="block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-300 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-600 dark:bg-neutral-800 dark:text-gray-100 dark:focus:ring-gray-600"
      >
        <option value="">No template (custom message)</option>
        {CHAT_PROMPT_TEMPLATES.map((promptTemplate) => (
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
