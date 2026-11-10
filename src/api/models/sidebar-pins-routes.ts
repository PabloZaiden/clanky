import { createLogger } from "@pablozaiden/webapp/server";
import { defineRoutes } from "@/platform/server";
import {
  AddSidebarPinRequestSchema,
  RemoveSidebarPinRequestSchema,
  SidebarPinsResponseSchema,
} from "@/contracts/schemas/sidebar-pins";
import { preferencesManager } from "@/core/preferences-manager";
import { CLANKY_REALTIME_RESOURCES } from "@/shared/realtime";
import { internalErrorResponse } from "../helpers";
import { parseAndValidate } from "../validation";

const log = createLogger("api:sidebar-pins");

export const sidebarPinsRoutes = defineRoutes({
  "/api/preferences/sidebar-pins": {
    auth: "user",
    sameOrigin: "mutations",
    tags: ["preferences"],
    description: "Read, add, or remove the authenticated user's sidebar pins.",
    operations: {
      GET: {
        requestSchema: undefined, querySchema: undefined,
        responseSchema: SidebarPinsResponseSchema,
        automation: { policy: "read" },
      },
      PUT: {
        requestSchema: AddSidebarPinRequestSchema, querySchema: undefined,
        responseSchema: SidebarPinsResponseSchema,
        automation: { policy: "write" },
      },
      DELETE: {
        requestSchema: RemoveSidebarPinRequestSchema, querySchema: undefined,
        responseSchema: SidebarPinsResponseSchema,
        automation: { policy: "write" },
      },
    },
    async GET(): Promise<Response> {
      try {
        return Response.json({ pins: preferencesManager.getSidebarPins() }, { headers: { "Cache-Control": "no-store" } });
      } catch (error) {
        log.error("Failed to load sidebar pins", { error: String(error) });
        return internalErrorResponse(error, { error: "sidebar_pins_failed", message: "Failed to load sidebar pins", status: 500 });
      }
    },
    async PUT(req, ctx): Promise<Response> {
      const body = await parseAndValidate(AddSidebarPinRequestSchema, req, { maxBodyBytes: 32_768 });
      if (!body.success) return body.response;
      try {
        preferencesManager.addSidebarPin(body.data.pin);
        ctx.userRealtime.publishChanged(CLANKY_REALTIME_RESOURCES.sidebarPins);
        return Response.json({ pins: preferencesManager.getSidebarPins() }, { headers: { "Cache-Control": "no-store" } });
      } catch (error) {
        log.error("Failed to add sidebar pin", { error: String(error) });
        return internalErrorResponse(error, { error: "sidebar_pin_save_failed", message: "Failed to add sidebar pin", status: 500 });
      }
    },
    async DELETE(req, ctx): Promise<Response> {
      const body = await parseAndValidate(RemoveSidebarPinRequestSchema, req, { maxBodyBytes: 32_768 });
      if (!body.success) return body.response;
      try {
        preferencesManager.removeSidebarPin(body.data.id);
        ctx.userRealtime.publishChanged(CLANKY_REALTIME_RESOURCES.sidebarPins);
        return Response.json({ pins: preferencesManager.getSidebarPins() }, { headers: { "Cache-Control": "no-store" } });
      } catch (error) {
        log.error("Failed to remove sidebar pin", { error: String(error) });
        return internalErrorResponse(error, { error: "sidebar_pin_save_failed", message: "Failed to remove sidebar pin", status: 500 });
      }
    },
  },
});
