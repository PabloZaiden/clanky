import { useEffect, useRef, useState, type FormEvent } from "react";
import { ErrorState } from "@pablozaiden/webapp/web";
import type { HarnessQuestionRequest } from "@/shared/harness-questions";
import type { QuestionInfo } from "@/shared/harness-events";
import { isQuestionOpen } from "@/shared/harness-questions";
import { apiRequest } from "../../lib/api-client";

const actionClass = "py-1 text-xs text-gray-500 underline decoration-dotted underline-offset-2 hover:text-gray-900 disabled:opacity-50 dark:text-gray-400 dark:hover:text-gray-100";

function QuestionField({ question, index, requestId, values, custom, disabled, onValues, onCustom }: {
  question: QuestionInfo; index: number; requestId: string; values: string[]; custom: string;
  disabled: boolean; onValues: (values: string[]) => void; onCustom: (value: string) => void;
}) {
  const name = `question-${requestId}-${index}`;
  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-2">
      <legend className="text-sm font-medium">{question.question}</legend>
      {question.options.map((option) => (
        <label key={option.label} className="flex cursor-pointer items-start gap-2 text-sm">
          <input type={question.multiple ? "checkbox" : "radio"} name={name}
            className="mt-1 shrink-0" checked={values.includes(option.label)}
            onChange={(event) => {
              onValues(question.multiple
                ? event.target.checked ? [...values, option.label] : values.filter((value) => value !== option.label)
                : [option.label]);
              if (!question.multiple) onCustom("");
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
            value={custom} onChange={(event) => { onCustom(event.target.value); if (!question.multiple) onValues([]); }} />
        </label>
      )}
    </fieldset>
  );
}

function QuestionForm({ chatId, request }: { chatId: string; request: HarnessQuestionRequest }) {
  const [values, setValues] = useState<string[][]>(() => request.questions.map(() => []));
  const [custom, setCustom] = useState<string[]>(() => request.questions.map(() => ""));
  const [submitting, setSubmitting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string>();
  const operation = useRef<AbortController | null>(null);
  useEffect(() => () => operation.current?.abort(), []);
  const disabled = submitting || stopping || request.status !== "pending";
  const answers = values.map((selection, index) => custom[index]?.trim() ? [...selection, custom[index]!.trim()] : selection);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (disabled) return;
    const controller = new AbortController();
    operation.current = controller;
    setSubmitting(true);
    setError(undefined);
    try {
      await apiRequest(`/api/chats/${encodeURIComponent(chatId)}/questions/${encodeURIComponent(request.requestId)}`, {
        method: "POST", body: JSON.stringify({ answers }), headers: { "content-type": "application/json" },
        signal: controller.signal, action: "Answer chat question",
      });
    } catch (failure) {
      if (!controller.signal.aborted) setError(String(failure));
    } finally {
      if (!controller.signal.aborted) setSubmitting(false);
    }
  }

  async function stop(): Promise<void> {
    if (stopping) return;
    const controller = new AbortController();
    operation.current?.abort();
    operation.current = controller;
    setStopping(true);
    setError(undefined);
    const path = request.scope.kind === "child"
      ? `activity/${encodeURIComponent(request.scope.activityId)}/stop`
      : "interrupt";
    try {
      await apiRequest(`/api/chats/${encodeURIComponent(chatId)}/${path}`, {
        method: "POST", body: "{}", headers: { "content-type": "application/json" },
        signal: controller.signal, action: "Stop pending chat question",
      });
    } catch (failure) {
      if (!controller.signal.aborted) setError(String(failure));
    } finally {
      if (!controller.signal.aborted) { setStopping(false); setSubmitting(false); }
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-3 border-t border-gray-200 px-4 py-3 text-gray-900 dark:border-gray-700 dark:text-gray-100">
      <div className="text-xs text-gray-500 dark:text-gray-400">
        {request.blocking ? "Waiting for your answer" : "Question"}
        {request.scope.kind === "child" ? " · Subagent" : ""}
      </div>
      {request.questions.map((question, index) => (
        <QuestionField key={index} question={question} index={index} requestId={request.requestId}
          values={values[index]!} custom={custom[index]!} disabled={disabled}
          onValues={(selection) => setValues((current) => current.map((value, position) => position === index ? selection : value))}
          onCustom={(text) => setCustom((current) => current.map((value, position) => position === index ? text : value))} />
      ))}
      {(request.error ?? error) && <ErrorState title="Question could not be updated" description={request.error ?? error} />}
      <button type="submit" className={actionClass} disabled={disabled || answers.some((answer, index) => !answer.length && request.questions[index]!.required !== false)}>
        {submitting || request.status === "submitting" ? "Sending answer"
          : request.status === "queued" ? "Answer queued" : request.status === "unconfirmed" ? "Delivery unconfirmed" : "Send answer"}
      </button>
      <button type="button" className={`${actionClass} ml-3 hover:text-red-600`} disabled={stopping} onClick={() => void stop()}>
        {stopping ? "Stopping" : "Stop"}
      </button>
    </form>
  );
}

export function ChatQuestions({ chatId, requests }: { chatId: string; requests: HarnessQuestionRequest[] }) {
  const visible = requests.filter(isQuestionOpen);
  const expired = requests.at(-1);
  if (!visible.length && expired?.status !== "expired") return null;
  return (
    <div className="max-h-[55vh] shrink-0 overflow-y-auto">
      {visible.map((request) => <QuestionForm key={request.requestId} chatId={chatId} request={request} />)}
      {!visible.length && expired?.status === "expired" && (
        <div className="border-t border-gray-200 px-4 py-2 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">The previous question has expired.</div>
      )}
    </div>
  );
}
