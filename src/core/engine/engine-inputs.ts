/**
 * Owns pending task input, native admission and atomic transcript checkpoints.
 */

import type { Backend } from "../../backends/types";
import type { TaskPromptIntent, TaskState } from "@/shared/task";
import type { MessageAttachment } from "@/shared/message-attachments";
import type { HarnessConversationBinding, HarnessInputAdmission, HarnessInputReceipt } from "@/shared/harness-control";
import { createTimestamp } from "@/shared/events";
import { HarnessError } from "../../backends/harness-errors";
import { requireMatchingHarnessBinding } from "../../backends/harness-binding";
import { buildPromptParts } from "../../backends/prompt-parts";
import { isHarnessInputValidationError, retainHarnessInputReceipt } from "../harness-input-ledger";
import { KeyedOperationQueue } from "../../utils/keyed-operation-queue";
import { TaskOperationError } from "../task/task-errors";

export interface PendingTaskInput {
  id: string;
  content: string;
  attachments: MessageAttachment[];
  intent: TaskPromptIntent;
}

interface TaskInputDependencies {
  state: TaskState;
  backend: Pick<Backend, "harness" | "isConnected">;
  updateState(update: Partial<TaskState>): void;
  emitUserMessage(content: string, id: string, attachments: MessageAttachment[]): void;
  flushInputs(): Promise<void>;
}

export class TaskInputService {
  private readonly operations = new KeyedOperationQueue();
  private activeOperations = 0;

  constructor(private readonly dependencies: TaskInputDependencies) {
    const state = dependencies.state;
    if (state.pendingPrompt !== undefined && !state.pendingInput && state.harness?.integrity !== "invalid") {
      dependencies.updateState({ pendingInput: { id: crypto.randomUUID(), attachments: [] } });
    }
  }

  get isBusy(): boolean { return this.activeOperations > 0; }

  waitForIdle(): Promise<void> { return this.operations.run(this.dependencies.state.id, async () => {}); }

  set(content: string, attachments: MessageAttachment[], intent: TaskPromptIntent): void {
    this.assertMutable();
    this.dependencies.updateState({
      pendingPrompt: content, pendingPromptMode: intent,
      pendingInput: { id: crypto.randomUUID(), attachments: structuredClone(attachments) },
    });
  }

  setAttachments(attachments: MessageAttachment[]): void {
    this.assertMutable();
    const input = this.dependencies.state.pendingInput;
    if (input) this.dependencies.updateState({ pendingInput: { ...input, attachments: structuredClone(attachments) } });
  }

  clear(): void {
    this.assertMutable();
    this.dependencies.updateState({ pendingPrompt: undefined, pendingPromptMode: undefined, pendingInput: undefined });
  }

  peek(): PendingTaskInput | undefined {
    const state = this.dependencies.state;
    if (state.harness?.integrity === "invalid") throw new TaskOperationError("task_input_unresolved", "Input history is invalid.");
    const input = state.pendingInput;
    if (state.pendingPrompt === undefined || !input) return undefined;
    const receipt = state.harness?.inputs?.find((entry) => entry.admission.inputId === input.id);
    if (receipt && receipt.admission.status !== "rejected") return undefined;
    return { ...input, content: state.pendingPrompt, intent: state.pendingPromptMode ?? "engine_context" };
  }

  consume(): PendingTaskInput | undefined {
    const input = this.peek();
    if (input) this.clear();
    return input;
  }

  steer(inputId: string): Promise<HarnessInputAdmission> {
    return this.serialize(async () => {
      const state = this.dependencies.state;
      this.assertIntegrity();
      const previous = state.harness?.inputs?.find((entry) => entry.admission.inputId === inputId);
      if (previous && previous.admission.status !== "rejected") return previous.admission;
      const input = this.peek();
      if (!input || input.id !== inputId) throw new HarnessError("harness_input_not_found", "The pending task input is unavailable.");
      const binding = this.binding();
      if (!["running", "planning"].includes(state.status)) return { status: "rejected", inputId, code: "not-running" };
      if (this.dependencies.backend.harness.capabilities.steering === "unsupported") return { status: "rejected", inputId, code: "unsupported" };
      const receipt: HarnessInputReceipt = { conversation: binding, submittedAt: createTimestamp(), admission: { status: "unknown", inputId } };
      this.record(receipt);
      // Claim durability precedes the native RPC; queue consumption cannot resend it.
      await this.dependencies.flushInputs();
      let admission: HarnessInputAdmission;
      try {
        admission = await this.dependencies.backend.harness.steer(binding.nativeId, {
          inputId, prompt: { parts: buildPromptParts(input.content, input.attachments) },
        });
      } catch (error) {
        if (isHarnessInputValidationError(error)) {
          await this.finish(receipt, { status: "rejected", inputId, code: "unsupported" });
        }
        throw error;
      }
      return this.finish(receipt, admission);
    });
  }

  reconcile(inputId: string): Promise<HarnessInputAdmission> {
    return this.serialize(async () => {
      this.assertIntegrity();
      const receipt = this.dependencies.state.harness?.inputs?.find((entry) => entry.admission.inputId === inputId);
      if (!receipt) throw new HarnessError("harness_input_not_found", "Native input admission is unavailable.");
      const previous = receipt.admission;
      if (previous.status === "rejected" || previous.status === "delivered") return previous;
      const binding = this.binding();
      requireMatchingHarnessBinding(JSON.stringify(receipt.conversation), binding);
      const admission = await this.dependencies.backend.harness.reconcileInput(binding.nativeId, {
        inputId,
        nativeMessageId: previous.status === "accepted" ? previous.nativeMessageId : undefined,
        nativeClientInputId: previous.status === "accepted" ? previous.nativeClientInputId : undefined,
        nativeTurnId: previous.status === "accepted" ? previous.nativeTurnId : undefined,
      });
      return this.finish(receipt, admission);
    });
  }

  private async finish(receipt: HarnessInputReceipt, admission: HarnessInputAdmission): Promise<HarnessInputAdmission> {
    if (admission.inputId !== receipt.admission.inputId) throw new HarnessError("harness_event_gap", "Native input correlation changed.");
    requireMatchingHarnessBinding(JSON.stringify(receipt.conversation), this.binding());
    const state = this.dependencies.state;
    this.record({ ...receipt, admission });
    if ((admission.status === "accepted" || admission.status === "delivered") && state.pendingInput?.id === admission.inputId) {
      if (state.pendingPrompt === undefined) throw new TaskOperationError("task_input_unresolved", "Admitted input content is unavailable.");
      this.dependencies.emitUserMessage(state.pendingPrompt, admission.inputId, state.pendingInput.attachments);
      this.dependencies.updateState({ pendingPrompt: undefined, pendingPromptMode: undefined, pendingInput: undefined });
    }
    await this.dependencies.flushInputs();
    return admission;
  }

  private record(receipt: HarnessInputReceipt): void {
    const state = this.dependencies.state;
    this.dependencies.updateState({
      harness: { ...state.harness, inputs: retainHarnessInputReceipt(state.harness?.inputs ?? [], receipt) },
    });
  }

  private binding(): HarnessConversationBinding {
    const binding = this.dependencies.state.session?.binding;
    if (!binding || binding.adapter !== this.dependencies.backend.harness.capabilities.adapter) {
      throw new HarnessError("harness_session_not_owned", "The input requires its exact owned conversation.");
    }
    if (!this.dependencies.backend.isConnected()) throw new HarnessError("harness_transport_closed", "Reconnect before native input admission.");
    return binding;
  }

  private assertIntegrity(): void {
    if (this.dependencies.state.harness?.integrity === "invalid") {
      throw new TaskOperationError("task_input_unresolved", "Input admission history is invalid.");
    }
  }

  private assertMutable(): void {
    this.assertIntegrity();
    const state = this.dependencies.state;
    if (state.harness?.inputs?.some((entry) => entry.admission.inputId === state.pendingInput?.id && entry.admission.status !== "rejected")) {
      throw new TaskOperationError("task_input_unresolved", "An admitted input cannot be replaced, removed or resent.");
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    return this.operations.run(this.dependencies.state.id, async () => {
      this.activeOperations++;
      try { return await operation(); } finally { this.activeOperations--; }
    });
  }
}
