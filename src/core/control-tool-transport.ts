import { createLogger } from "@pablozaiden/webapp/server";
import { CONTROL_REQUEST_MAX_BYTES } from "@/contracts/schemas/control";
import { ControlToolRequestSchema, type ControlToolRequest, type ControlToolFailure } from "@/contracts/schemas/control-tool-transport";
import type { ManagedContextIdentity } from "@/shared/context-api-key";
import type { ControlAccess } from "./control-session-service";
import { DomainError } from "../domain/domain-error";

const log = createLogger("core:control-tool-transport");

export type { ControlToolRequest };
export type ControlToolRequestHandler = (
  request: ControlToolRequest, signal: AbortSignal, workerNodeId?: string,
) => Promise<unknown>;
export interface ControlToolConnection {
  request: ControlToolRequestHandler;
}
export interface ExecutionControlConnection extends ControlToolConnection {
  readonly access: ControlAccess;
}
type ExecutionControlFactory = (identity: ManagedContextIdentity) => Promise<ExecutionControlConnection>;
let executionControlFactory: ExecutionControlFactory | undefined;

export function configureExecutionControl(value: ExecutionControlFactory): void {
  executionControlFactory = value;
}

export async function createExecutionControlConnection(
  identity: ManagedContextIdentity,
): Promise<ExecutionControlConnection> {
  if (!executionControlFactory) throw new DomainError("control_unavailable", "Execution-owned application control is unavailable.");
  return await executionControlFactory(Object.freeze({ ...identity }));
}

export async function requestControlTool(
  connection: ControlToolConnection, request: ControlToolRequest, signal?: AbortSignal, workerNodeId?: string,
): Promise<unknown> {
  let serialized: string;
  try { serialized = JSON.stringify(request); }
  catch (error) {
    throw new DomainError("control_request_invalid", "The control request must be JSON serializable.", { cause: error });
  }
  if (Buffer.byteLength(serialized) > CONTROL_REQUEST_MAX_BYTES) {
    throw new DomainError("control_request_invalid", "The control request exceeds the supported size limit.");
  }
  const bounded = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
  bounded.throwIfAborted();
  const parsed = ControlToolRequestSchema.safeParse(JSON.parse(serialized));
  if (!parsed.success) throw new DomainError("control_request_invalid", "The control request is invalid.");
  let interrupted!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    interrupted = () => reject(new DomainError("control_cancelled",
      "The control request ended without an authoritative result. Inspect the target before repeating a mutation."));
    bounded.addEventListener("abort", interrupted, { once: true });
  });
  let result: unknown;
  try {
    bounded.throwIfAborted();
    result = await Promise.race([connection.request(parsed.data, bounded, workerNodeId), cancelled]);
  } finally {
    bounded.removeEventListener("abort", interrupted);
  }
  bounded.throwIfAborted();
  let response: string | undefined;
  try { response = JSON.stringify(result); }
  catch (error) {
    throw new DomainError("control_result_invalid", "The control result is not JSON serializable.", { cause: error });
  }
  if (response === undefined || Buffer.byteLength(response) > 1024 * 1024) {
    throw new DomainError("control_result_invalid", "The control result exceeds the supported size limit.");
  }
  return JSON.parse(response) as unknown;
}

export function controlToolTransportFailure(error: unknown): ControlToolFailure {
  const notExecuted = error instanceof DomainError && (error.details["notExecuted"] === true || [
    "control_request_invalid", "control_context_unavailable", "control_credential_invalid",
    "control_scope_required", "control_scope_invalid", "control_tool_unavailable",
    "control_context_invalid", "unknown_control_tool",
  ].includes(error.code));
  log.error("Control tool transport failed", {
    code: error instanceof DomainError ? error.code : "control_transport_failed",
  });
  return {
    ok: false, completion: notExecuted ? "not_executed" : "outcome_unknown",
    error: {
      code: error instanceof DomainError ? error.code : "control_transport_failed",
      message: notExecuted ? "The control request was rejected before execution. Check its input and current execution grant."
        : "No authoritative control result was received. Inspect the target before repeating a mutation.",
    },
  };
}
