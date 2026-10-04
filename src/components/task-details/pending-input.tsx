import type { Task } from "@/shared/task";
import { HarnessInputActions } from "../harness-input-actions";

export function TaskPendingInput({
  task,
  onRefresh,
}: {
  task: Task;
  onRefresh: () => Promise<void>;
}) {
  const input = task.state.pendingInput;
  if (!input) return null;
  const harness = task.state.harness;
  const receipt = harness?.inputs?.find((item) => item.admission.inputId === input.id);
  const active = task.state.status === "running" || task.state.status === "planning";
  return (
    <div className="mx-3 my-2 shrink-0 rounded-md border border-dashed border-amber-300 px-3 py-2 text-sm dark:border-amber-800/80 sm:mx-4">
      <div className="mb-1 flex items-center gap-2 text-xs text-amber-700 dark:text-amber-300">
        <span>Queued message</span>
        {input.attachments.length > 0 && <span>{input.attachments.length} image{input.attachments.length === 1 ? "" : "s"}</span>}
      </div>
      <p className="max-h-28 overflow-y-auto whitespace-pre-wrap break-words">{task.state.pendingPrompt}</p>
      <HarnessInputActions
        kind="task"
        entityId={task.config.id}
        inputId={input.id}
        receipt={receipt}
        canSteer={active && harness?.capabilities !== undefined && harness.capabilities.steering !== "unsupported"}
        onUpdated={onRefresh}
      />
    </div>
  );
}
