import { useRef, type ClipboardEvent } from "react";
import { getTemplateById } from "../../lib/prompt-templates";
import type { ComposerImageAttachment } from "@/shared/message-attachments";
import {
  ImageAttachmentControl,
  type ImageAttachmentControlHandle,
} from "../ImageAttachmentControl";
import { DictationControls, insertDictationText } from "../dictation";

interface PromptFieldProps {
  prompt: string;
  onChange: (value: string) => void;
  attachments: ComposerImageAttachment[];
  onAttachmentsChange: (attachments: ComposerImageAttachment[]) => void;
  planMode: boolean;
  selectedTemplate: string;
  onTemplateClear: () => void;
}

export function PromptField({
  prompt,
  onChange,
  attachments,
  onAttachmentsChange,
  planMode,
  selectedTemplate,
  onTemplateClear,
}: PromptFieldProps) {
  const attachmentControlRef = useRef<ImageAttachmentControlHandle>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    attachmentControlRef.current?.handlePaste(event);
  }

  function handlePromptChange(newValue: string) {
    onChange(newValue);
    // Reset template selection if user edits the prompt away from the template text
    if (selectedTemplate) {
      const template = getTemplateById(selectedTemplate);
      if (template && newValue !== template.prompt) {
        onTemplateClear();
      }
    }
  }

  function handleDictationTranscript(transcript: string) {
    const insertion = insertDictationText(
      prompt,
      transcript,
      textareaRef.current?.selectionStart,
      textareaRef.current?.selectionEnd,
    );
    handlePromptChange(insertion.value);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(insertion.caretPosition, insertion.caretPosition);
    });
  }

  function handleClipboardText(text: string) {
    const textarea = textareaRef.current;
    const selectionStart = textarea?.selectionStart ?? prompt.length;
    const selectionEnd = textarea?.selectionEnd ?? selectionStart;
    const start = Math.min(Math.max(selectionStart, 0), prompt.length);
    const end = Math.min(Math.max(selectionEnd, start), prompt.length);
    const nextPrompt = `${prompt.slice(0, start)}${text}${prompt.slice(end)}`;
    const caretPosition = start + text.length;

    handlePromptChange(nextPrompt);
    requestAnimationFrame(() => {
      const currentTextarea = textareaRef.current;
      currentTextarea?.focus();
      currentTextarea?.setSelectionRange(caretPosition, caretPosition);
    });
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <label
          htmlFor="prompt"
          className="block text-sm font-medium text-gray-700 dark:text-gray-300"
        >
          Prompt <span className="text-red-500">*</span>
        </label>
        <DictationControls
          compact
          onTranscript={handleDictationTranscript}
        />
      </div>
      <textarea
        ref={textareaRef}
        id="prompt"
        value={prompt}
        onChange={(e) => {
          handlePromptChange(e.target.value);
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
          showClipboardTrigger
          onClipboardText={handleClipboardText}
        />
      </div>
    </div>
  );
}
