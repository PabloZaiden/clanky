import type {
  ControlUiAction,
  ControlUiActionEvent,
  ControlUiActionOutcome,
} from "@/shared/clanky-control";
import type { ChatEvent } from "@/shared/events";
import { chatEventEmitter } from "./event-emitter";
import type { SimpleEventEmitter } from "./event-emitter";
import { DomainError } from "../domain/domain-error";

const ACTION_ACK_TIMEOUT_MS = 20_000;
const COMPLETED_ACTION_TTL_MS = 60_000;
const MAX_PENDING_ACTIONS = 128;
const MAX_COMPLETED_ACTIONS = 256;

export interface ControlUiActionDispatch {
  ownerId: string;
  chatId: string;
  workspaceId: string;
  clientId: string;
  turnId: string;
  action: ControlUiAction;
}

export interface ControlUiActionAcknowledgement {
  clientId: string;
  chatId: string;
  turnId: string;
  outcome: ControlUiActionOutcome;
}

interface PendingControlUiAction extends ControlUiActionDispatch {
  actionId: string;
  expiresAt: number;
  resolve: (outcome: ControlUiActionOutcome) => void;
  reject: (error: unknown) => void;
  settled: boolean;
  timer?: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
  signal?: AbortSignal;
}

interface CompletedControlUiAction extends ControlUiActionDispatch {
  actionId: string;
  outcome: ControlUiActionOutcome;
  expiresAt: number;
}

export class ControlUiActionService {
  private readonly pending = new Map<string, PendingControlUiAction>();
  private readonly completed = new Map<string, CompletedControlUiAction>();

  constructor(
    private readonly eventEmitter: Pick<SimpleEventEmitter<ChatEvent>, "emit"> = chatEventEmitter,
  ) {}

  async dispatch(
    request: ControlUiActionDispatch,
    signal?: AbortSignal,
  ): Promise<{ actionId: string; outcome: ControlUiActionOutcome }> {
    this.pruneCompleted();
    if (this.pending.size >= MAX_PENDING_ACTIONS) {
      throw new DomainError("control_action_busy", "Too many UI actions are awaiting acknowledgement.");
    }
    if (signal?.aborted) {
      throw new DomainError("control_action_cancelled", "The originating request was cancelled.");
    }

    let resolve!: (outcome: ControlUiActionOutcome) => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<ControlUiActionOutcome>((resolveResult, rejectResult) => {
      resolve = resolveResult;
      reject = rejectResult;
    });
    const pending: PendingControlUiAction = {
      ...request,
      actionId: crypto.randomUUID(),
      expiresAt: Date.now() + ACTION_ACK_TIMEOUT_MS,
      resolve,
      reject,
      settled: false,
      signal,
    };
    this.pending.set(pending.actionId, pending);
    pending.timer = setTimeout(() => {
      this.settle(pending, {
        status: "failed",
        code: "control_action_timeout",
        message: "The originating browser tab did not acknowledge the action before it expired.",
      });
    }, Math.max(0, pending.expiresAt - Date.now()));
    pending.onAbort = () => {
      this.rejectPending(
        pending,
        new DomainError("control_action_cancelled", "The originating request was cancelled."),
      );
    };
    signal?.addEventListener("abort", pending.onAbort, { once: true });

    try {
      if (signal?.aborted) {
        pending.onAbort();
      } else {
        const event: ControlUiActionEvent = {
          type: "control.ui_action",
          actionId: pending.actionId,
          chatId: pending.chatId,
          workspaceId: pending.workspaceId,
          clientId: pending.clientId,
          turnId: pending.turnId,
          expiresAt: pending.expiresAt,
          action: pending.action,
        };
        this.eventEmitter.emit(event, { userId: pending.ownerId });
      }
      return { actionId: pending.actionId, outcome: await result };
    } finally {
      if (pending.timer) clearTimeout(pending.timer);
      if (pending.onAbort) signal?.removeEventListener("abort", pending.onAbort);
      if (this.pending.get(pending.actionId) === pending) {
        this.pending.delete(pending.actionId);
      }
    }
  }

  acknowledge(
    ownerId: string,
    actionId: string,
    acknowledgement: ControlUiActionAcknowledgement,
  ): void {
    this.pruneCompleted();
    const pending = this.pending.get(actionId);
    if (!pending) {
      const completed = this.completed.get(actionId);
      if (completed && this.matchesAcknowledgement(completed, ownerId, acknowledgement)
        && this.sameOutcome(completed.outcome, acknowledgement.outcome)) {
        return;
      }
      throw new DomainError("control_action_not_found", "The pending UI action is unavailable.");
    }
    if (pending.settled) {
      const completed = this.completed.get(actionId);
      if (completed && this.matchesAcknowledgement(completed, ownerId, acknowledgement)
        && this.sameOutcome(completed.outcome, acknowledgement.outcome)) {
        return;
      }
      throw new DomainError("control_action_not_found", "The pending UI action is unavailable.");
    }
    if (!this.matchesAcknowledgement(pending, ownerId, acknowledgement)) {
      throw new DomainError("control_action_not_found", "The pending UI action is unavailable.");
    }
    if (
      acknowledgement.outcome.status === "opened"
      && !this.sameAction(pending.action, acknowledgement.outcome.action)
    ) {
      throw new DomainError("control_action_not_found", "The pending UI action is unavailable.");
    }
    this.settle(pending, acknowledgement.outcome);
  }

  private settle(pending: PendingControlUiAction, outcome: ControlUiActionOutcome): boolean {
    if (pending.settled) {
      return false;
    }
    pending.settled = true;
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = undefined;
    }
    this.rememberCompleted(pending, outcome);
    pending.resolve(outcome);
    return true;
  }

  private rejectPending(pending: PendingControlUiAction, error: unknown): void {
    if (pending.settled) {
      return;
    }
    pending.settled = true;
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = undefined;
    }
    pending.reject(error);
  }

  private matchesAcknowledgement(
    request: ControlUiActionDispatch,
    ownerId: string,
    acknowledgement: ControlUiActionAcknowledgement,
  ): boolean {
    return request.ownerId === ownerId
      && request.chatId === acknowledgement.chatId
      && request.clientId === acknowledgement.clientId
      && request.turnId === acknowledgement.turnId;
  }

  private rememberCompleted(
    request: PendingControlUiAction,
    outcome: ControlUiActionOutcome,
  ): void {
    this.completed.set(request.actionId, {
      ownerId: request.ownerId,
      chatId: request.chatId,
      workspaceId: request.workspaceId,
      clientId: request.clientId,
      turnId: request.turnId,
      action: request.action,
      actionId: request.actionId,
      outcome,
      expiresAt: Date.now() + COMPLETED_ACTION_TTL_MS,
    });
    while (this.completed.size > MAX_COMPLETED_ACTIONS) {
      const oldestActionId = this.completed.keys().next().value;
      if (!oldestActionId) break;
      this.completed.delete(oldestActionId);
    }
  }

  private pruneCompleted(): void {
    const now = Date.now();
    for (const [actionId, action] of this.completed) {
      if (action.expiresAt <= now) {
        this.completed.delete(actionId);
      }
    }
  }

  private sameAction(left: ControlUiAction, right: ControlUiAction): boolean {
    if (left.type !== right.type) {
      return false;
    }
    switch (left.type) {
      case "open_workspace":
        return right.type === left.type && left.workspaceId === right.workspaceId;
      case "open_workspace_file":
        return right.type === left.type
          && left.workspaceId === right.workspaceId
          && left.filePath === right.filePath;
      case "open_chat":
        return right.type === left.type && left.chatId === right.chatId;
    }
  }

  private sameOutcome(left: ControlUiActionOutcome, right: ControlUiActionOutcome): boolean {
    if (left.status !== right.status) {
      return false;
    }
    if (left.status === "opened" && right.status === "opened") {
      return this.sameAction(left.action, right.action);
    }
    return left.status === "failed"
      && right.status === "failed"
      && left.code === right.code
      && left.message === right.message;
  }
}

export const controlUiActionService = new ControlUiActionService();
