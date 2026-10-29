/**
 * Session-owned access to the common application-control tools.
 */
import { z } from "zod";
import { ClankyControlContextSchema, type ClankyControlContext } from "@/shared/clanky-control";
import {
  requestControlTool, controlToolTransportFailure, type ControlToolConnection,
} from "../core/control-tool-transport";
import { HarnessError } from "./harness-errors";
import { DomainError } from "../domain/domain-error";
import { createLogger } from "@pablozaiden/webapp/server";

const log = createLogger("backends:clanky-control-tools");

const ToolInventorySchema = z.object({
  tools: z.array(z.object({
    name: z.string().regex(/^[A-Za-z0-9_-]+$/).max(128),
    description: z.string().max(30_000),
    inputSchema: z.record(z.string(), z.json()),
  }).strict()).max(100),
}).strict();
export type ClankyControlToolDefinition = z.infer<typeof ToolInventorySchema>["tools"][number];
export type ClankyControlToolResult = unknown;
interface ToolDiscoveryOptions { chatId?: string; signal?: AbortSignal }

export class ClankyControlToolService {
  private readonly toolsByName = new Set<string>();
  private readonly lifetime = new AbortController();

  constructor(private readonly connection: ControlToolConnection) {
    if (typeof connection?.request !== "function") {
      throw new HarnessError("harness_runtime_unavailable", "Execution-owned Clanky control is unavailable.");
    }
  }

  async listTools({ chatId, signal }: ToolDiscoveryOptions = {}): Promise<readonly ClankyControlToolDefinition[]> {
    let response: unknown;
    try {
      response = await requestControlTool(this.connection, {
        operation: "list", ...(chatId ? { chatId } : {}),
      }, AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]));
    } catch (error) {
      log.error("Execution-owned control discovery failed", {
        code: error instanceof DomainError ? error.code : "control_transport_failed",
        ...(error instanceof DomainError && typeof error.details["status"] === "number"
          ? { status: error.details["status"] } : {}),
      });
      throw error;
    }
    const parsed = ToolInventorySchema.safeParse(response);
    if (!parsed.success) {
      throw new DomainError("control_result_invalid", "The Clanky control inventory is invalid.", { cause: parsed.error });
    }
    const inventory = parsed.data;
    if (new Set(inventory.tools.map((tool) => tool.name)).size !== inventory.tools.length) {
      throw new DomainError("control_result_invalid", "The Clanky control inventory contains duplicate tool names.");
    }
    for (const definition of inventory.tools) this.toolsByName.add(definition.name);
    return inventory.tools;
  }

  async invoke(
    name: string, input: unknown, context: ClankyControlContext | undefined, signal?: AbortSignal,
  ): Promise<ClankyControlToolResult> {
    const parsed = ClankyControlContextSchema.optional().safeParse(context);
    if (!parsed.success) {
      return controlToolTransportFailure(new DomainError("control_context_invalid", "The supplied Clanky chat-turn context is invalid."));
    }
    if (!this.toolsByName.has(name)) {
      return controlToolTransportFailure(new DomainError("unknown_control_tool", "The requested Clanky tool is not available."));
    }
    try {
      return await requestControlTool(this.connection, {
        operation: "call", name, input, ...(parsed.data ? { context: parsed.data } : {}),
      }, AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]));
    } catch (error) {
      return controlToolTransportFailure(error);
    }
  }

  close(): void {
    this.lifetime.abort();
    this.toolsByName.clear();
  }
}
