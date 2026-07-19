import { defineRoutes } from "@pablozaiden/webapp/server";
/**
 * AGENTS.md optimization API endpoints.
 *
 * Provides endpoints for reading, previewing, and applying
 * Clanky optimization to a workspace's AGENTS.md file.
 *
 * @module api/agents-md
 */

import { agentsMdService } from "../core/agents-md-service";
import { isDomainError } from "../core/domain-error";
import { createLogger } from "@pablozaiden/webapp/server";
import { domainErrorResponse, errorResponse } from "./helpers";

const log = createLogger("api:agents-md");

type AgentsMdOperation = "read" | "preview" | "optimize";

function mapAgentsMdError(error: unknown, operation: AgentsMdOperation): Response {
  if (isDomainError(error)) {
    if (error.code === "workspace_not_found") {
      return errorResponse("workspace_not_found", "Workspace not found", 404);
    }
    if (error.code === "agents_md_read_failed") {
      return domainErrorResponse(error, {
        mappings: {
          agents_md_read_failed: {
            error: "read_failed",
            status: 500,
            message: "Failed to read AGENTS.md",
          },
        },
        fallback: {
          error: "read_failed",
          message: "Failed to read AGENTS.md",
          status: 500,
        },
      });
    }
    if (error.code === "agents_md_write_failed") {
      return domainErrorResponse(error, {
        mappings: {
          agents_md_write_failed: {
            error: "write_failed",
            status: 500,
            message: "Failed to update AGENTS.md",
          },
        },
        fallback: {
          error: "write_failed",
          message: "Failed to update AGENTS.md",
          status: 500,
        },
      });
    }
  }

  if (operation === "read") {
    return errorResponse("read_failed", "Failed to read AGENTS.md", 500);
  }
  if (operation === "preview") {
    return errorResponse("preview_failed", "Failed to preview optimization", 500);
  }
  return errorResponse("optimize_failed", "Failed to optimize AGENTS.md", 500);
}

export const agentsMdRoutes = defineRoutes({
  /**
   * GET /api/workspaces/:id/agents-md
   *
   * Reads the current AGENTS.md content and its optimization status.
   */
  "/api/workspaces/:id/agents-md": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Read the AGENTS.md file and optimization status for a workspace.",
    GET: async (_req: Request, ctx) => {
      const id = ctx.params["id"]!;
      log.debug("GET /api/workspaces/:id/agents-md", { workspaceId: id });

      try {
        return Response.json(await agentsMdService.read(id));
      } catch (error) {
        log.error("Failed to read AGENTS.md", { workspaceId: id, error: String(error) });
        return mapAgentsMdError(error, "read");
      }
    },
  },

  /**
   * POST /api/workspaces/:id/agents-md/preview
   *
   * Returns a preview of what the optimized AGENTS.md would look like.
   */
  "/api/workspaces/:id/agents-md/preview": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Preview AGENTS.md optimization changes for a workspace.",
    POST: async (_req: Request, ctx) => {
      const id = ctx.params["id"]!;
      log.debug("POST /api/workspaces/:id/agents-md/preview", { workspaceId: id });

      try {
        return Response.json(await agentsMdService.preview(id));
      } catch (error) {
        log.error("Failed to preview AGENTS.md optimization", {
          workspaceId: id,
          error: String(error),
        });
        return mapAgentsMdError(error, "preview");
      }
    },
  },

  /**
   * POST /api/workspaces/:id/agents-md/optimize
   *
   * Applies the Clanky optimization to the workspace's AGENTS.md.
   */
  "/api/workspaces/:id/agents-md/optimize": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Apply AGENTS.md optimization changes to a workspace.",
    POST: async (_req: Request, ctx) => {
      const id = ctx.params["id"]!;
      log.debug("POST /api/workspaces/:id/agents-md/optimize", { workspaceId: id });

      try {
        const result = await agentsMdService.optimize(id);
        return Response.json({ success: true, ...result });
      } catch (error) {
        log.error("Failed to optimize AGENTS.md", { workspaceId: id, error: String(error) });
        return mapAgentsMdError(error, "optimize");
      }
    },
  },
});
