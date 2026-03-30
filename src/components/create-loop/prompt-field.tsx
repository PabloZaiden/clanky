import { useRef, type ClipboardEvent } from "react";
import { getTemplateById } from "../../lib/prompt-templates";
import type { ComposerImageAttachment } from "../../types/message-attachments";
import {
  ImageAttachmentControl,
  type ImageAttachmentControlHandle,
} from "../ImageAttachmentControl";

interface PromptFieldProps {
  prompt: string;
  onChange: (value: string) => void;
  attachments: ComposerImageAttachment[];
  onAttachmentsChange: (attachments: ComposerImageAttachment[]) => void;
  planMode: boolean;
  isEditingDraft?: boolean;
  selectedTemplate: string;
  onTemplateClear: () => void;
}

export function PromptField({
  prompt,
  onChange,
  attachments,
  onAttachmentsChange,
  planMode,
  isEditingDraft: _isEditingDraft = false,
  selectedTemplate,
  onTemplateClear,
}: PromptFieldProps) {
  const attachmentControlRef = useRef<ImageAttachmentControlHandle>(null);

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    attachmentControlRef.current?.handlePaste(event);
  }

  return (
    <div>
      <label
        htmlFor="prompt"
        className="block text-sm font-medium text-gray-700 dark:text-gray-300"
      >
        Prompt <span className="text-red-500">*</span>
      </label>
      <textarea
        id="prompt"
        value={prompt}
        onChange={(e) => {
          const newValue = e.target.value;
          onChange(newValue);
          // Reset template selection if user edits the prompt away from the template text
          if (selectedTemplate) {
            const template = getTemplateById(selectedTemplate);
            if (template && newValue !== template.prompt) {
              onTemplateClear();
            }
          }
        }}
        onPaste={handlePaste}
        placeholder={planMode ? "Describe what you want to achieve. The AI will create a detailed plan based on this." : "Do everything that's pending in the plan"}
        required
        rows={3}
        className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900 shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-300 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100 dark:focus:ring-gray-600 min-h-[76px] sm:min-h-[120px] resize-y"
      />
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
        The prompt sent to the AI agent at the start of each iteration
      </p>
      <div className="mt-3">
        <ImageAttachmentControl
          ref={attachmentControlRef}
          attachments={attachments}
          onChange={onAttachmentsChange}
          iconOnly
        />
      </div>
    </div>
  );
}
