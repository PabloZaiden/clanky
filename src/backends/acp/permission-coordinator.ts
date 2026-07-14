/**
 * Permission and question coordination for the ACP backend.
 *
 * Owns inbound permission-request state (the JSON-RPC response ID and the
 * available options), permission event emission, response normalization, and
 * the construction of selected/cancelled outcomes. Legacy permission and
 * question reply method attempts flow through the typed optional-method helper.
 * Pending permission requests are cleared on disconnect so no request is left
 * waiting on a dead process.
 */

import { log } from "../../core/logger";

import { isRecord, getString, firstString } from "./json-helpers";
import { tryOptionalMethods } from "./optional-method";
import type { JsonRpcMessage, PendingPermissionRequest } from "./types";
import type { RpcRequester } from "./contracts";
import type { SessionStateStore } from "./session-state";

export class PermissionCoordinator {
  /** Track active permission requests that expect a JSON-RPC response. */
  private readonly pendingPermissionRequests = new Map<string, PendingPermissionRequest>();

  constructor(
    private readonly rpc: RpcRequester,
    private readonly state: SessionStateStore,
  ) {}

  clearAll(): void {
    this.pendingPermissionRequests.clear();
  }

  clearSession(sessionId: string): void {
    for (const [requestId, request] of this.pendingPermissionRequests) {
      if (request.sessionId === sessionId) {
        this.pendingPermissionRequests.delete(requestId);
      }
    }
  }

  /** Handle an inbound `session/request_permission` message. */
  handleRequestPermission(message: JsonRpcMessage): void {
    const params = message.params;
    if (!isRecord(params)) {
      return;
    }
    const sessionId = getString(params["sessionId"]);
    if (!sessionId) {
      return;
    }
    const toolCall = isRecord(params["toolCall"]) ? params["toolCall"] : {};
    const requestId = message.id !== undefined
      ? `permission-${sessionId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      : firstString(params["requestId"], toolCall["toolCallId"]);
    if (!requestId) {
      return;
    }

    const permission = firstString(
      params["permission"],
      toolCall["kind"],
      toolCall["title"],
    ) ?? "*";
    const rawInput = isRecord(toolCall["rawInput"]) ? toolCall["rawInput"] : {};

    const patternsFromCommands = Array.isArray(rawInput["commands"])
      ? rawInput["commands"].filter((p): p is string => typeof p === "string")
      : [];
    const patterns = Array.isArray(params["patterns"])
      ? params["patterns"].filter((p): p is string => typeof p === "string")
      : patternsFromCommands.length > 0
        ? patternsFromCommands
        : firstString(rawInput["command"])
          ? [String(rawInput["command"])]
          : ["*"];

    const options = Array.isArray(params["options"])
      ? params["options"]
        .filter((option): option is Record<string, unknown> => isRecord(option))
        .map((option) => ({
          optionId: getString(option["optionId"]) ?? "",
          kind: getString(option["kind"]),
        }))
        .filter((option) => option.optionId.length > 0)
      : [];

    if (message.id !== undefined) {
      this.pendingPermissionRequests.set(requestId, {
        sessionId,
        rpcId: message.id,
        options,
      });
    }

    this.state.emitSessionEvent(sessionId, {
      type: "permission.asked",
      requestId,
      sessionId,
      permission,
      patterns,
    });
  }

  async replyToPermission(requestId: string, response: string): Promise<void> {
    const pendingRequest = this.pendingPermissionRequests.get(requestId);
    if (pendingRequest) {
      const normalizedResponse = response.toLowerCase();
      const preferredKinds =
        normalizedResponse === "always"
          ? ["allow_always", "allow_once"]
          : normalizedResponse === "once" || normalizedResponse === "allow"
            ? ["allow_once", "allow_always"]
            : normalizedResponse === "reject" || normalizedResponse === "deny"
              ? ["reject_once", "reject_always"]
              : [];

      let optionId = pendingRequest.options.find((option) => option.optionId === response)?.optionId;
      if (!optionId) {
        for (const preferredKind of preferredKinds) {
          optionId = pendingRequest.options.find((option) => option.kind === preferredKind)?.optionId;
          if (optionId) {
            break;
          }
        }
      }
      optionId = optionId
        ?? pendingRequest.options.find((option) => option.kind?.startsWith("allow"))?.optionId
        ?? pendingRequest.options[0]?.optionId;

      this.pendingPermissionRequests.delete(requestId);

      this.rpc.writeMessage({
        jsonrpc: "2.0",
        id: pendingRequest.rpcId,
        result: {
          outcome: optionId
            ? { outcome: "selected", optionId }
            : { outcome: "cancelled" },
        },
      });
      return;
    }

    const outcome = await tryOptionalMethods(
      this.rpc,
      ["session/reply_permission", "session/permission_reply"],
      { requestId, response },
      10_000,
    );

    if (outcome.kind === "method-not-found") {
      log.debug("[AcpBackend] Permission reply is not supported by current ACP provider", {
        requestId,
        response,
      });
    }
  }

  async replyToQuestion(requestId: string, answers: string[][]): Promise<void> {
    const outcome = await tryOptionalMethods(
      this.rpc,
      ["session/reply_question", "session/question_reply"],
      { requestId, answers },
      10_000,
    );

    if (outcome.kind === "method-not-found") {
      log.debug("[AcpBackend] Question reply is not supported by current ACP provider", {
        requestId,
        answersCount: answers.length,
      });
    }
  }
}
