import { describe, expect, test } from "bun:test";
import type { ChatEvent } from "@/shared/events";
import type { ControlUiActionEvent } from "@/shared/clanky-control";
import { ControlUiActionService } from "../../src/core/control-ui-action-service";
import { DomainError } from "../../src/domain/domain-error";
import { SimpleEventEmitter } from "../../src/core/event-emitter";

describe("ControlUiActionService", () => {
  /**
   * The transient browser acknowledgement is an owner/tab/turn boundary that
   * has no durable snapshot representation; exercise its public event contract.
   */
  test("accepts only the originating owner, tab, chat and turn; exact acknowledgements are idempotent", async () => {
    const eventEmitter = new SimpleEventEmitter<ChatEvent>();
    const service = new ControlUiActionService(eventEmitter);
    const request = {
      ownerId: "user-a",
      chatId: "control-chat-a",
      workspaceId: "workspace-control",
      clientId: "d53b3522-2bc7-4cd2-97ac-7b77b0e222e0",
      turnId: "a913d1b1-4b0e-4a9a-933f-c88d3936a5a4",
      action: { type: "open_workspace", workspaceId: "workspace-target" } as const,
    };
    let observedEvent: ControlUiActionEvent | undefined;
    let observedOwnerId: string | undefined;
    const mismatchErrors: unknown[] = [];
    const unsubscribe = eventEmitter.subscribe((event, context) => {
      if (event.type !== "control.ui_action") {
        return;
      }
      observedEvent = event;
      observedOwnerId = context.userId;
      const acknowledgement = {
        clientId: request.clientId,
        chatId: request.chatId,
        turnId: request.turnId,
        outcome: { status: "opened" as const, action: request.action },
      };
      const invalidAcknowledgements = [
        { ownerId: "user-b", acknowledgement },
        {
          ownerId: request.ownerId,
          acknowledgement: {
            ...acknowledgement,
            clientId: "a54d5ac3-d7ac-415c-8a6e-98f6f98a53f8",
          },
        },
        {
          ownerId: request.ownerId,
          acknowledgement: {
            ...acknowledgement,
            chatId: "other-chat",
          },
        },
        {
          ownerId: request.ownerId,
          acknowledgement: {
            ...acknowledgement,
            turnId: "0c329d0b-702b-4841-9faf-9bc131e1d7b1",
          },
        },
        {
          ownerId: request.ownerId,
          acknowledgement: {
            ...acknowledgement,
            outcome: {
              status: "opened" as const,
              action: { type: "open_workspace" as const, workspaceId: "other-workspace" },
            },
          },
        },
      ];
      for (const invalid of invalidAcknowledgements) {
        try {
          service.acknowledge(invalid.ownerId, event.actionId, invalid.acknowledgement);
        } catch (error) {
          mismatchErrors.push(error);
        }
      }
      service.acknowledge(request.ownerId, event.actionId, acknowledgement);
      service.acknowledge(request.ownerId, event.actionId, acknowledgement);
    });

    try {
      const result = await service.dispatch(request);
      expect(observedEvent).toMatchObject({
        type: "control.ui_action",
        chatId: request.chatId,
        workspaceId: request.workspaceId,
        clientId: request.clientId,
        turnId: request.turnId,
        action: request.action,
      });
      expect(observedEvent?.expiresAt).toBeGreaterThan(Date.now());
      expect(observedOwnerId).toBe(request.ownerId);
      expect(result).toMatchObject({
        outcome: { status: "opened", action: request.action },
      });
      expect(mismatchErrors).toHaveLength(5);
      expect(mismatchErrors.every((error) => (
        error instanceof DomainError && error.code === "control_action_not_found"
      ))).toBe(true);
    } finally {
      unsubscribe();
    }
  });
});
