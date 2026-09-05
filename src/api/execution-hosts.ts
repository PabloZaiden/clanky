/**
 * Transport-neutral execution-host discovery routes.
 */

import { createLogger, defineRoutes } from "@pablozaiden/webapp/server";
import { executionHostService } from "../core/execution-host-service";
import { chatManager } from "../core/chat-manager";
import { CreateExecutionHostChatRequestSchema } from "@/contracts/schemas";
import {
  CheckSshServerPrerequisitesRequestSchema,
  DiscoverExecutionHostModelsRequestSchema,
  DiscoverExecutionHostProvidersRequestSchema,
  GetDevboxTemplatesRequestSchema,
  UpdateExecutionHostConfigurationSchema,
} from "@/contracts/schemas";
import type { ExecutionHostRef } from "@/shared";
import { domainErrorResponse, errorResponse } from "./helpers";
import { parseAndValidate } from "./validation";
import { sshCredentialManager } from "../core/ssh-credential-manager";
import { executionHostDiscoveryService } from "../core/execution-host-discovery-service";
import { AGENT_PROVIDER_IDS } from "../constants/agent-providers";
import { buildProviderAvailabilityShellCheck } from "../core/agent-runtime-command";
import { getModelsForExecutionHost } from "../core/model-discovery";
import { executionHostConfigurationService } from "../core/execution-host-configuration-service";

const log = createLogger("api:execution-hosts");

function parseExecutionHostRef(kind: string, id: string): ExecutionHostRef | null {
  if (kind === "local" || kind === "mesh") {
    return { kind, nodeId: id };
  }
  if (kind === "ssh") {
    return { kind, serverId: id };
  }
  return null;
}

function resolveSshPassword(
  ref: ExecutionHostRef,
  credentialToken: string | null,
): string | undefined {
  if (ref.kind !== "ssh" || !credentialToken) {
    return undefined;
  }
  return sshCredentialManager.getPasswordForToken(ref.serverId, credentialToken);
}

export const executionHostRoutes = defineRoutes({
  "/api/execution-hosts": {
    auth: "user",
    sameOrigin: "mutations",
    description: "List execution hosts available to the current user.",
    async GET(): Promise<Response> {
      try {
        return Response.json(await executionHostService.listHosts());
      } catch (error) {
        log.error("Failed to list execution hosts", { error: String(error) });
        return errorResponse(
          "execution_hosts_unavailable",
          "Failed to list execution hosts.",
          500,
        );
      }
    },
  },
  "/api/execution-hosts/:kind/:id/working-directory": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Resolve the configured or current directory of an execution host.",
    async GET(_req, ctx): Promise<Response> {
      const ref = parseExecutionHostRef(ctx.params["kind"]!, ctx.params["id"]!);
      if (!ref) {
        return errorResponse(
          "execution_host_kind_invalid",
          "Execution host kind must be local, mesh, or ssh.",
          400,
        );
      }
      try {
        return Response.json(
          await executionHostService.resolveWorkingDirectory(ref, {
            userId: ctx.requireUser().id,
          }),
        );
      } catch (error) {
        log.error("Failed to resolve execution-host working directory", {
          kind: ref.kind,
          error: String(error),
        });
        return domainErrorResponse(error, {
          fallback: {
            error: "execution_host_directory_unavailable",
            message: "Failed to resolve the execution-host working directory.",
            status: 500,
          },
          mappings: {
            execution_host_unavailable: {
              status: 404,
              message: "Execution host not found or unavailable.",
            },
          },
        });
      }
    },
  },
  "/api/execution-hosts/:kind/:id/configuration": {
    auth: "owner",
    sameOrigin: "mutations",
    description: "Update node-owned defaults for a local or Mesh execution host.",
    requestSchema: UpdateExecutionHostConfigurationSchema,
    async PATCH(req, ctx): Promise<Response> {
      const validation = await parseAndValidate(
        UpdateExecutionHostConfigurationSchema,
        req,
      );
      if (!validation.success) {
        return validation.response;
      }
      const ref = parseExecutionHostRef(ctx.params["kind"]!, ctx.params["id"]!);
      if (!ref) {
        return errorResponse(
          "execution_host_kind_invalid",
          "Execution host kind must be local, mesh, or ssh.",
          400,
        );
      }
      try {
        return Response.json(
          await executionHostConfigurationService.updateNodeDefaults(
            ref,
            validation.data,
            ctx.requireOwner().id,
          ),
        );
      } catch (error) {
        log.error("Failed to update execution-host configuration", {
          kind: ref.kind,
          error: String(error),
        });
        return domainErrorResponse(error, {
          fallback: {
            error: "execution_host_configuration_failed",
            message: "Failed to update execution-host configuration.",
            status: 500,
          },
          mappings: {
            execution_host_unavailable: {
              status: 404,
              message: "Execution host not found or unavailable.",
            },
            execution_host_directory_invalid: {
              status: 400,
              message: "The selected directory does not exist on the execution host.",
            },
            execution_host_configuration_unsupported: {
              status: 400,
              message: "This execution host must be configured through its transport settings.",
            },
            mesh_execution_configuration_stale: {
              status: 409,
              message: "The execution-host configuration changed. Refresh and try again.",
            },
            mesh_control_request_unreachable: {
              status: 503,
              message: "The Mesh execution host could not be reached.",
            },
            mesh_control_request_rejected: {
              status: 502,
              message: "The Mesh execution host rejected the configuration update.",
            },
          },
        });
      }
    },
  },
  "/api/execution-hosts/:kind/:id/chats": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Create a direct chat on an execution host.",
    requestSchema: CreateExecutionHostChatRequestSchema,
    async POST(req, ctx): Promise<Response> {
      const validation = await parseAndValidate(CreateExecutionHostChatRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }
      const ref = parseExecutionHostRef(ctx.params["kind"]!, ctx.params["id"]!);
      if (!ref) {
        return errorResponse(
          "execution_host_kind_invalid",
          "Execution host kind must be local, mesh, or ssh.",
          400,
        );
      }
      try {
        const binding = executionHostService.getBinding(ref);
        const sshPassword = resolveSshPassword(
          ref,
          validation.data.credentialToken ?? null,
        );
        await executionHostService.assertDirectoryExists(
          ref,
          validation.data.directory,
          { sshPassword },
        );
        const chat = await chatManager.createExecutionHostChat({
          name: validation.data.name,
          executionHost: binding,
          directory: validation.data.directory,
          modelProviderID: validation.data.model.providerID,
          modelID: validation.data.model.modelID,
          modelVariant: validation.data.model.variant,
          autoApprovePermissions: validation.data.autoApprovePermissions,
        });
        return Response.json(chat, { status: 201 });
      } catch (error) {
        log.error("Failed to create execution-host chat", {
          kind: ref.kind,
          error: String(error),
        });
        return domainErrorResponse(error, {
          fallback: {
            error: "execution_host_chat_failed",
            message: "Failed to create execution-host chat.",
            status: 500,
          },
          mappings: {
            execution_host_unavailable: {
              status: 404,
              error: "execution_host_unavailable",
              message: "Execution host not found or unavailable.",
            },
            execution_host_binding_stale: {
              status: 409,
              error: "execution_host_binding_stale",
              message: "Execution host configuration changed.",
            },
            execution_host_directory_invalid: {
              status: 400,
              message: "The selected directory does not exist on the execution host.",
            },
          },
        });
      }
    },
  },
  "/api/execution-hosts/:kind/:id/prerequisites": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Check prerequisites on an execution host.",
    requestSchema: CheckSshServerPrerequisitesRequestSchema,
    async POST(req, ctx): Promise<Response> {
      const validation = await parseAndValidate(CheckSshServerPrerequisitesRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }
      const ref = parseExecutionHostRef(ctx.params["kind"]!, ctx.params["id"]!);
      if (!ref) {
        return errorResponse("execution_host_kind_invalid", "Invalid execution host kind.", 400);
      }
      try {
        const descriptor = (await executionHostService.listHosts())
          .find((host) => JSON.stringify(host.ref) === JSON.stringify(ref));
        if (!descriptor) {
          return errorResponse("execution_host_unavailable", "Execution host not found or unavailable.", 404);
        }
        const report = await executionHostDiscoveryService.checkPrerequisites(ref, {
          operationId: `prerequisites:${ctx.params["id"]!}`,
          directory: "/",
          repositoriesBasePath: descriptor.repositoriesBasePath,
          responseId: ctx.params["id"]!,
          sshPassword: resolveSshPassword(ref, validation.data.credentialToken),
        });
        return Response.json(report);
      } catch (error) {
        log.error("Failed to check execution-host prerequisites", {
          kind: ref.kind,
          error: String(error),
        });
        return domainErrorResponse(error, {
          fallback: {
            error: "execution_host_prerequisites_failed",
            message: "Failed to check execution-host prerequisites.",
            status: 500,
          },
        });
      }
    },
  },
  "/api/execution-hosts/:kind/:id/devbox-templates": {
    auth: "user",
    sameOrigin: "mutations",
    description: "List Devbox templates on an execution host.",
    requestSchema: GetDevboxTemplatesRequestSchema,
    async POST(req, ctx): Promise<Response> {
      const validation = await parseAndValidate(GetDevboxTemplatesRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }
      const ref = parseExecutionHostRef(ctx.params["kind"]!, ctx.params["id"]!);
      if (!ref) {
        return errorResponse("execution_host_kind_invalid", "Invalid execution host kind.", 400);
      }
      try {
        executionHostService.getBinding(ref);
        const templates = await executionHostDiscoveryService.listDevboxTemplates(ref, {
          operationId: `devbox-templates:${ctx.params["id"]!}`,
          directory: "/",
          sshPassword: resolveSshPassword(ref, validation.data.credentialToken),
        });
        return Response.json(templates);
      } catch (error) {
        log.error("Failed to list execution-host Devbox templates", {
          kind: ref.kind,
          error: String(error),
        });
        return domainErrorResponse(error, {
          fallback: {
            error: "execution_host_templates_failed",
            message: "Failed to list execution-host Devbox templates.",
            status: 500,
          },
        });
      }
    },
  },
  "/api/execution-hosts/:kind/:id/chat-providers": {
            auth: "user",
            sameOrigin: "mutations",
            description: "Discover ACP providers available on an execution host.",
            requestSchema: DiscoverExecutionHostProvidersRequestSchema,
            async POST(req, ctx): Promise<Response> {
              const validation = await parseAndValidate(DiscoverExecutionHostProvidersRequestSchema, req);
              if (!validation.success) {
                return validation.response;
              }
              const ref = parseExecutionHostRef(ctx.params["kind"]!, ctx.params["id"]!);
              if (!ref) {
                return errorResponse("execution_host_kind_invalid", "Invalid execution host kind.", 400);
              }
              try {
                executionHostService.getBinding(ref);
                const executor = await executionHostService.getCommandExecutorForRef(ref, {
                  operationId: `provider-discovery:${ctx.params["id"]!}`,
                  directory: "/",
                  sshPassword: resolveSshPassword(ref, validation.data.credentialToken ?? null),
                });
                const results = await Promise.all(AGENT_PROVIDER_IDS.map(async (providerID) => ({
                  providerID,
                  available: (await executor.exec(
                    "sh",
                    ["-lc", buildProviderAvailabilityShellCheck(providerID)],
                    { cwd: "/" },
                  )).success,
                })));
                return Response.json({ providers: results });
              } catch (error) {
                log.error("Failed to discover execution-host providers", {
                  kind: ref.kind,
                  error: String(error),
                });
                return domainErrorResponse(error, {
                  fallback: {
                    error: "execution_host_provider_discovery_failed",
                    message: "Failed to discover execution-host providers.",
                    status: 500,
                  },
                });
              }
            },
  },
  "/api/execution-hosts/:kind/:id/chat-models": {
            auth: "user",
            sameOrigin: "mutations",
            description: "Discover ACP models for a provider on an execution host.",
            requestSchema: DiscoverExecutionHostModelsRequestSchema,
            async POST(req, ctx): Promise<Response> {
              const validation = await parseAndValidate(DiscoverExecutionHostModelsRequestSchema, req);
              if (!validation.success) {
                return validation.response;
              }
              const ref = parseExecutionHostRef(ctx.params["kind"]!, ctx.params["id"]!);
              if (!ref) {
                return errorResponse("execution_host_kind_invalid", "Invalid execution host kind.", 400);
              }
              try {
                const binding = executionHostService.getBinding(ref);
                const models = await getModelsForExecutionHost(
                  binding,
                  validation.data.directory,
                  validation.data.providerID,
                  resolveSshPassword(ref, validation.data.credentialToken ?? null),
                );
                return Response.json(
                  models.filter((model) => model.providerID === validation.data.providerID),
                );
              } catch (error) {
                log.error("Failed to discover execution-host models", {
                  kind: ref.kind,
                  providerID: validation.data.providerID,
                  error: String(error),
                });
                return domainErrorResponse(error, {
                  fallback: {
                    error: "execution_host_model_discovery_failed",
                    message: "Failed to discover execution-host models.",
                    status: 500,
          },
        });
      }
    },
  },
});
