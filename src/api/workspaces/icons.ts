/**
 * Authenticated workspace icon routes.
 */

import { createLogger, defineRoutes } from "@pablozaiden/webapp/server";
import {
  WorkspaceIconCandidatesResponseSchema,
  WorkspaceIconCandidateQuerySchema,
  WorkspaceIconCandidateRequestSchema,
} from "@/contracts/schemas";
import { CLANKY_REALTIME_RESOURCES } from "@/shared/realtime";
import { DomainError, isDomainError } from "../../domain/domain-error";
import {
  getWorkspaceIconContent,
  listWorkspaceIconCandidates,
  previewWorkspaceIconCandidate,
  removeWorkspaceIcon,
  selectWorkspaceIconCandidate,
  uploadWorkspaceIcon,
  WORKSPACE_ICON_MULTIPART_BODY_LIMIT,
} from "../../core/workspace-icon-service";
import {
  domainErrorResponse,
  errorResponse,
  requireWorkspace,
} from "../helpers";
import { parseAndValidate } from "../validation";
import { workspaceOperation, workspaceAdministrationOperation } from "../workspace-delegation";
import { requireResourceOwnerUserId } from "../../context/user-context";

const log = createLogger("api:workspace-icons");

function workspaceIconErrorResponse(
  error: unknown,
  fallback: { error: string; message: string },
): Response {
  return domainErrorResponse(error, {
    policy: "workspaces",
    fallback: { ...fallback, status: 500 },
  });
}

function reportWorkspaceIconFailure(
  operation: string,
  workspaceId: string,
  error: unknown,
  fallback: { error: string; message: string },
): Response {
  const response = workspaceIconErrorResponse(error, fallback);
  const context = {
    workspaceId,
    status: response.status,
    ...(isDomainError(error) ? { errorCode: error.code } : { error: String(error) }),
  };
  if (response.status >= 500) {
    log.error(`Failed to ${operation} workspace icon`, context);
  } else {
    log.warn(`Rejected workspace icon ${operation}`, context);
  }
  return response;
}

function imageResponse(
  content: Uint8Array,
  mimeType: string,
  cacheControl: string,
): Response {
  const body = content.buffer.slice(
    content.byteOffset,
    content.byteOffset + content.byteLength,
  ) as ArrayBuffer;
  return new Response(body, {
    headers: {
      "Cache-Control": cacheControl,
      "Content-Length": String(content.byteLength),
      "Content-Type": mimeType,
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function readRequestBodyWithLimit(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!request.body) {
    throw new DomainError("workspace_icon_invalid", "The icon upload is empty.");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const abort = (): void => {
    void reader.cancel().catch(() => {
      // The request is already aborted, so there is no response to recover.
    });
  };
  request.signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (request.signal.aborted) {
        throw new DOMException("The icon upload was aborted.", "AbortError");
      }
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => {
          // Keep the size violation as the authoritative error.
        });
        throw new DomainError(
          "workspace_icon_too_large",
          "Workspace icons must be 1 MB or smaller.",
        );
      }
      chunks.push(value);
    }
  } finally {
    request.signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function workspaceIdFromContext(ctx: { params: Record<string, string | undefined> }): string {
  return ctx.params["id"]!;
}

export const workspaceIconRoutes = defineRoutes({
  "/api/workspaces/:id/icon": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Read, select, or remove the private icon for a workspace.",
    requestSchema: WorkspaceIconCandidateRequestSchema,
    operations: {
      GET: { delegation: workspaceOperation("workspace"), requestSchema: undefined, automation: { policy: "read" } },
      PUT: { delegation: workspaceAdministrationOperation(), automation: { policy: "write" } },
      DELETE: { delegation: workspaceAdministrationOperation(), automation: { policy: "write" } },
    },
    async GET(_req: Request, ctx) {
      const workspaceResult = await requireWorkspace(workspaceIdFromContext(ctx));
      if (workspaceResult instanceof Response) {
        return workspaceResult;
      }
      try {
        const icon = await getWorkspaceIconContent(workspaceResult.id);
        if (!icon) {
          return errorResponse(
            "workspace_icon_not_found",
            "This workspace does not have an icon.",
            404,
          );
        }
        return imageResponse(icon.content, icon.mimeType, "private, max-age=0, must-revalidate");
      } catch (error) {
        return reportWorkspaceIconFailure("read", workspaceResult.id, error, {
          error: "workspace_icon_read_failed",
          message: "Failed to read workspace icon.",
        });
      }
    },

    async PUT(req: Request, ctx) {
      const workspaceResult = await requireWorkspace(workspaceIdFromContext(ctx));
      if (workspaceResult instanceof Response) {
        return workspaceResult;
      }
      const parsed = await parseAndValidate(WorkspaceIconCandidateRequestSchema, req);
      if (!parsed.success) {
        return parsed.response;
      }
      try {
        const metadata = await selectWorkspaceIconCandidate(
          workspaceResult,
          parsed.data.path,
          req.signal,
        );
        ctx.realtime.publishEntityChanged(
          CLANKY_REALTIME_RESOURCES.workspaces,
          workspaceResult.id,
          { target: { userId: requireResourceOwnerUserId(workspaceResult.id) } },
        );
        return Response.json({ workspaceIcon: metadata });
      } catch (error) {
        return reportWorkspaceIconFailure("select", workspaceResult.id, error, {
          error: "workspace_icon_selection_failed",
          message: "Failed to select workspace icon.",
        });
      }
    },

    async DELETE(_req: Request, ctx) {
      const workspaceResult = await requireWorkspace(workspaceIdFromContext(ctx));
      if (workspaceResult instanceof Response) {
        return workspaceResult;
      }
      try {
        await removeWorkspaceIcon(workspaceResult.id);
        ctx.realtime.publishEntityChanged(
          CLANKY_REALTIME_RESOURCES.workspaces,
          workspaceResult.id,
          { target: { userId: requireResourceOwnerUserId(workspaceResult.id) } },
        );
        return Response.json({ success: true });
      } catch (error) {
        return reportWorkspaceIconFailure("remove", workspaceResult.id, error, {
          error: "workspace_icon_remove_failed",
          message: "Failed to remove workspace icon.",
        });
      }
    },
  },

  "/api/workspaces/:id/icon-upload": {
    delegation: workspaceAdministrationOperation(),
    auth: "user",
    sameOrigin: "mutations",
    description: "Upload a private SVG or ICO icon for a workspace.",
    async POST(req: Request, ctx) {
      const workspaceResult = await requireWorkspace(workspaceIdFromContext(ctx));
      if (workspaceResult instanceof Response) {
        return workspaceResult;
      }
      const contentType = req.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
        return errorResponse("workspace_icon_invalid", "Upload an SVG or ICO file.", 400);
      }

      let form: FormData;
      try {
        const body = await readRequestBodyWithLimit(req, WORKSPACE_ICON_MULTIPART_BODY_LIMIT);
        form = await new Response(body.buffer as ArrayBuffer, {
          headers: { "Content-Type": contentType },
        }).formData();
      } catch (error) {
        if (
          req.signal.aborted
          || error instanceof DOMException && error.name === "AbortError"
        ) {
          throw error;
        }
        if (isDomainError(error)) {
          return reportWorkspaceIconFailure("upload", workspaceResult.id, error, {
            error: "workspace_icon_upload_failed",
            message: "Failed to upload workspace icon.",
          });
        }
        return errorResponse("workspace_icon_invalid", "Upload an SVG or ICO file.", 400);
      }

      const entries = [...form.entries()];
      const iconValue: unknown = form.get("icon");
      let iconFile: File | null = null;
      if (
        entries.length === 1
        && entries[0]?.[0] === "icon"
        && iconValue instanceof File
      ) {
        iconFile = iconValue;
      }
      if (!iconFile) {
        return errorResponse("workspace_icon_invalid", "Upload one SVG or ICO file.", 400);
      }

      try {
        const metadata = await uploadWorkspaceIcon(
          workspaceResult,
          iconFile.name,
          iconFile.type,
          new Uint8Array(await iconFile.arrayBuffer()),
        );
        ctx.realtime.publishEntityChanged(
          CLANKY_REALTIME_RESOURCES.workspaces,
          workspaceResult.id,
          { target: { userId: requireResourceOwnerUserId(workspaceResult.id) } },
        );
        return Response.json({ workspaceIcon: metadata });
      } catch (error) {
        return reportWorkspaceIconFailure("upload", workspaceResult.id, error, {
          error: "workspace_icon_upload_failed",
          message: "Failed to upload workspace icon.",
        });
      }
    },
  },

  "/api/workspaces/:id/icon-candidates": {
    delegation: workspaceAdministrationOperation(),
    auth: "user",
    sameOrigin: "mutations",
    description: "Find workspace SVG and ICO icons available in a Git repository.",
    responseSchema: WorkspaceIconCandidatesResponseSchema,
    operations: {
      GET: { requestSchema: undefined, querySchema: undefined, automation: { policy: "read" } },
    },
    async GET(req: Request, ctx) {
      const workspaceResult = await requireWorkspace(workspaceIdFromContext(ctx));
      if (workspaceResult instanceof Response) {
        return workspaceResult;
      }
      try {
        return Response.json(await listWorkspaceIconCandidates(workspaceResult, req.signal));
      } catch (error) {
        return reportWorkspaceIconFailure("discover", workspaceResult.id, error, {
          error: "workspace_icon_discovery_failed",
          message: "Failed to discover workspace icon candidates.",
        });
      }
    },
  },

  "/api/workspaces/:id/icon-candidate-preview": {
    delegation: workspaceAdministrationOperation(),
    auth: "user",
    sameOrigin: "mutations",
    description: "Preview a sanitized icon candidate from a workspace Git repository.",
    querySchema: WorkspaceIconCandidateQuerySchema,
    async GET(req: Request, ctx) {
      const workspaceResult = await requireWorkspace(workspaceIdFromContext(ctx));
      if (workspaceResult instanceof Response) {
        return workspaceResult;
      }
      const query = WorkspaceIconCandidateQuerySchema.safeParse({
        path: new URL(req.url).searchParams.get("path"),
      });
      if (!query.success) {
        return errorResponse("validation_failed", "A valid icon candidate path is required.", 400);
      }
      try {
        const icon = await previewWorkspaceIconCandidate(
          workspaceResult,
          query.data.path,
          req.signal,
        );
        return imageResponse(icon.content, icon.mimeType, "no-store");
      } catch (error) {
        return reportWorkspaceIconFailure("preview", workspaceResult.id, error, {
          error: "workspace_icon_preview_failed",
          message: "Failed to preview workspace icon candidate.",
        });
      }
    },
  },
});
