import { useEffect, useRef, useState } from "react";
import { ErrorState } from "@pablozaiden/webapp/web";
import type { Chat } from "@/shared";
import type { HarnessQuestionRequest } from "@/shared/harness-questions";
import type { QuestionInfo } from "@/shared/harness-events";
import { isQuestionOpen } from "@/shared/harness-questions";
import { apiRequest } from "../../lib/api-client";
import { getClankyClientId } from "../../lib/clanky-client-id";
import type { ComposerAttachment } from "@/shared/message-attachments";
import { toMessageAttachments } from "../../lib/image-attachments";
import { ImageAttachmentControl, type ImageAttachmentControlHandle } from "../ImageAttachmentControl";
import { SECRET_MAX_BYTES } from "@/shared/harness-secrets";

const actionClass = "py-1 text-xs text-gray-500 underline decoration-dotted underline-offset-2 hover:text-gray-900 disabled:opacity-50 dark:text-gray-400 dark:hover:text-gray-100";

function isQuestionAnswerInput(target: EventTarget | null): target is HTMLInputElement | HTMLTextAreaElement {
  return target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement
    && (target.type === "text" || target.type === "number");
}

function SecretForm({ chatId, request, onChatSnapshot }: {
  chatId: string;
  request: HarnessQuestionRequest;
  onChatSnapshot: (chat: Chat) => void;
}) {
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const operation = useRef<AbortController | null>(null);
  useEffect(() => () => operation.current?.abort(), []);
  const disabled = submitting || request.status !== "pending";
  const tooLarge = new TextEncoder().encode(value).byteLength > SECRET_MAX_BYTES;

  async function submit(declined: boolean): Promise<void> {
    if (disabled || !declined && (!value.length || tooLarge)) return;
    const body = JSON.stringify({ value: declined ? null : value });
    setValue("");
    setShow(false);
    setError(undefined);
    setSubmitting(true);
    const controller = new AbortController();
    operation.current = controller;
    try {
      const { chat } = await apiRequest<{ chat: Chat }>(
        `/api/chats/${encodeURIComponent(chatId)}/secrets/${encodeURIComponent(request.requestId)}`, {
          method: "POST", body, headers: { "content-type": "application/json" },
          signal: controller.signal, action: "Supply private secret",
        },
      );
      onChatSnapshot(chat);
    } catch {
      if (!controller.signal.aborted) setError("Private delivery could not be confirmed. Refresh the conversation before entering the secret again.");
    } finally {
      if (!controller.signal.aborted) setSubmitting(false);
    }
  }

  return (
    <div className="space-y-3 border-t border-gray-200 px-4 py-3 text-gray-900 dark:border-gray-700 dark:text-gray-100">
      <div className="break-words text-sm font-medium">Private secret: {request.questions[0]?.header}</div>
      <p className="break-words text-sm">{request.questions[0]?.question}</p>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Saved privately on the execution host, not in chat. Reusable in this conversation for 24 hours.
        {" "}Agent commands and processes running as the same OS user can read it. The CLI may print or retain it.
      </p>
      <label className="block text-xs text-gray-500 dark:text-gray-400">
        Your secret
        <textarea
          aria-label="Your secret" autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false}
          rows={3} maxLength={SECRET_MAX_BYTES} disabled={disabled}
          className={`mt-1 block w-full resize-y rounded border border-gray-200 bg-transparent px-2 py-1.5 text-sm text-gray-900 dark:border-gray-700 dark:text-gray-100 ${show ? "" : "[-webkit-text-security:disc]"}`}
          value={value} onChange={(event) => setValue(event.target.value)} />
      </label>
      {tooLarge && <p className="text-xs text-red-600 dark:text-red-400">The secret must be at most 64 KiB.</p>}
      {(request.error ?? error) && <ErrorState title="Secret could not be delivered" description={request.error ?? error} />}
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <button type="button" className={actionClass} disabled={disabled || !value.length || tooLarge} onClick={() => void submit(false)}>
          {submitting || request.status === "submitting" ? "Delivering secret" : request.status === "unconfirmed" ? "Delivery unconfirmed" : "Provide secret"}
        </button>
        <button type="button" className={actionClass} disabled={disabled} onClick={() => void submit(true)}>Decline</button>
        <button type="button" className={actionClass} disabled={disabled} aria-pressed={show} onClick={() => setShow((current) => !current)}>
          {show ? "Hide secret" : "Show secret"}
        </button>
      </div>
    </div>
  );
}

function QuestionField({ question, index, requestId, values, custom, attachments, otherAttachments, disabled, numbered, onValues, onCustom, onAttachments, onProcessingChange }: {
  question: QuestionInfo; index: number; requestId: string; values: string[]; custom: string;
  disabled: boolean; numbered: boolean; onValues: (values: string[]) => void; onCustom: (value: string) => void;
  attachments: ComposerAttachment[]; otherAttachments: ComposerAttachment[];
  onAttachments: (attachments: ComposerAttachment[]) => void; onProcessingChange: (processing: boolean) => void;
}) {
  const name = `question-${requestId}-${index}`;
  const attachmentControl = useRef<ImageAttachmentControlHandle>(null);
  const imagesEnabled = question.custom !== false && question.valueType !== "number" && question.valueType !== "integer";
  return (
    <fieldset disabled={disabled} aria-label={numbered ? `Answer ${index + 1}` : "Answer"} className="min-w-0 space-y-2">
      {numbered && <legend className="text-sm font-medium">{index + 1}.</legend>}
      {question.options.map((option) => (
        <label key={option.label} className="flex cursor-pointer items-start gap-2 text-sm">
          <input type={question.multiple ? "checkbox" : "radio"} name={name}
            className="mt-1 shrink-0" checked={values.includes(option.label)}
            onChange={(event) => {
              onValues(question.multiple
                ? event.target.checked ? [...values, option.label] : values.filter((value) => value !== option.label)
                : [option.label]);
              if (!question.multiple) { onCustom(""); onAttachments([]); }
            }} />
          <span className="min-w-0 break-words">{option.label}
            {option.description && <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">{option.description}</span>}
          </span>
        </label>
      ))}
      {question.custom !== false && (
        <label className="block text-xs text-gray-500 dark:text-gray-400">
          {question.options.length ? "Other answer" : "Your answer"}
          <input aria-label={question.options.length ? "Other answer" : "Your answer"}
            type={question.valueType === "number" || question.valueType === "integer" ? "number" : "text"}
            step={question.valueType === "integer" ? 1 : "any"} min={question.minimum} max={question.maximum}
            minLength={question.minLength} maxLength={question.maxLength}
            className="mt-1 block w-full rounded border border-gray-200 bg-transparent px-2 py-1.5 text-sm text-gray-900 dark:border-gray-700 dark:text-gray-100"
            value={custom}
            onPaste={imagesEnabled ? (event) => attachmentControl.current?.handlePaste(event) : undefined}
            onChange={(event) => { onCustom(event.target.value); if (!question.multiple) onValues([]); }} />
        </label>
      )}
      {imagesEnabled && (
        <ImageAttachmentControl
          ref={attachmentControl}
          attachments={attachments}
          otherAttachments={otherAttachments}
          imagesOnly
          onChange={(next) => {
            onAttachments(next);
            if (next.length && !question.multiple) onValues([]);
          }}
          onProcessingChange={onProcessingChange}
          disabled={disabled}
          showTrigger={false}
        />
      )}
    </fieldset>
  );
}

function QuestionForm({
  chatId,
  request,
  onChatSnapshot,
}: {
  chatId: string;
  request: HarnessQuestionRequest;
  onChatSnapshot: (chat: Chat) => void;
}) {
  const [values, setValues] = useState<string[][]>(() => request.questions.map(() => []));
  const [custom, setCustom] = useState<string[]>(() => request.questions.map(() => ""));
  const [attachments, setAttachments] = useState<ComposerAttachment[][]>(() => request.questions.map(() => []));
  const [processing, setProcessing] = useState<boolean[]>(() => request.questions.map(() => false));
  const [submitting, setSubmitting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string>();
  const operation = useRef<AbortController | null>(null);
  useEffect(() => () => operation.current?.abort(), []);
  const disabled = submitting || stopping || request.status !== "pending";
  const answers = values.map((selection, index) => custom[index]?.trim() ? [...selection, custom[index]!.trim()] : selection);

  async function submit(): Promise<void> {
    if (disabled || processing.some(Boolean)) return;
    const controller = new AbortController();
    operation.current = controller;
    setSubmitting(true);
    setError(undefined);
    try {
      const { chat } = await apiRequest<{ chat: Chat }>(
        `/api/chats/${encodeURIComponent(chatId)}/questions/${encodeURIComponent(request.requestId)}`,
        {
          method: "POST",
          body: JSON.stringify({
            answers,
            attachments: attachments.map(toMessageAttachments),
            clientId: getClankyClientId(),
          }),
          headers: { "content-type": "application/json" },
          signal: controller.signal, action: "Answer chat question",
        },
      );
      onChatSnapshot(chat);
      setAttachments(request.questions.map(() => []));
    } catch (failure) {
      if (!controller.signal.aborted) setError(String(failure));
    } finally {
      if (!controller.signal.aborted) setSubmitting(false);
    }
  }

  async function stopSubagent(): Promise<void> {
    if (stopping || request.scope.kind !== "child") return;
    const controller = new AbortController();
    operation.current?.abort();
    operation.current = controller;
    setStopping(true);
    setError(undefined);
    try {
      await apiRequest(`/api/chats/${encodeURIComponent(chatId)}/activity/${encodeURIComponent(request.scope.activityId)}/stop`, {
        method: "POST", body: "{}", headers: { "content-type": "application/json" },
        signal: controller.signal, action: "Stop subagent activity",
      });
    } catch (failure) {
      if (!controller.signal.aborted) setError(String(failure));
    } finally {
      if (!controller.signal.aborted) { setStopping(false); setSubmitting(false); }
    }
  }

  return (
    <div className="space-y-3 border-t border-gray-200 px-4 py-3 text-gray-900 dark:border-gray-700 dark:text-gray-100">
      <div className="text-xs text-gray-500 dark:text-gray-400">
        {request.blocking ? "Waiting for your answer" : "Question"}
        {request.scope.kind === "child" ? " · Subagent" : ""}
      </div>
      {request.questions.map((question, index) => (
        <QuestionField key={index} question={question} index={index} requestId={request.requestId}
          numbered={request.questions.length > 1}
          values={values[index]!} custom={custom[index]!} disabled={disabled || processing[index]!}
          attachments={attachments[index]!} otherAttachments={attachments.flatMap((group, position) => position === index ? [] : group)}
          onValues={(selection) => setValues((current) => current.map((value, position) => position === index ? selection : value))}
          onAttachments={(images) => setAttachments((current) => current.map((value, position) => position === index ? images : value))}
          onProcessingChange={(busy) => setProcessing((current) => current.map((value, position) => position === index ? busy : value))}
          onCustom={(text) => setCustom((current) => current.map((value, position) => position === index ? text : value))} />
      ))}
      {(request.error ?? error) && <ErrorState title="Question could not be updated" description={request.error ?? error} />}
      <button type="button" className={actionClass} disabled={disabled || processing.some(Boolean) || answers.some((answer, index) => !answer.length && !attachments[index]!.length && request.questions[index]!.required !== false)} onClick={() => void submit()}>
        {submitting || request.status === "submitting" ? "Sending answer"
          : request.status === "queued" ? "Answer queued" : request.status === "unconfirmed" ? "Delivery unconfirmed" : "Send answer"}
      </button>
      {request.scope.kind === "child" && (
        <button type="button" className={`${actionClass} ml-3 hover:text-red-600`} disabled={stopping} onClick={() => void stopSubagent()}>
          {stopping ? "Stopping Subagent" : "Stop Subagent"}
        </button>
      )}
    </div>
  );
}

export function ChatQuestions({
  chatId,
  requests,
  onChatSnapshot,
  onAnswerInputFocusChange,
}: {
  chatId: string;
  requests: HarnessQuestionRequest[];
  onChatSnapshot: (chat: Chat) => void;
  onAnswerInputFocusChange: (focused: boolean) => void;
}) {
  const visible = requests.filter(isQuestionOpen);

  useEffect(() => {
    if (!visible.length) onAnswerInputFocusChange(false);
  }, [onAnswerInputFocusChange, visible.length]);

  if (!visible.length) return null;
  return (
    <div
      onFocusCapture={(event) => {
        if (isQuestionAnswerInput(event.target)) onAnswerInputFocusChange(true);
      }}
      onBlurCapture={(event) => {
        if (
          isQuestionAnswerInput(event.target)
          && !isQuestionAnswerInput(event.relatedTarget)
        ) {
          onAnswerInputFocusChange(false);
        }
      }}
    >
      {visible.map((request) => request.secretIdentifier !== undefined
        ? <SecretForm key={request.requestId} chatId={chatId} request={request} onChatSnapshot={onChatSnapshot} />
        : <QuestionForm key={request.requestId} chatId={chatId} request={request} onChatSnapshot={onChatSnapshot} />)}
    </div>
  );
}
