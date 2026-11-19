import { createLogger } from "@pablozaiden/webapp/server";
import type { HarnessDiagnostic } from "@/shared/harness-diagnostics";
import type { HarnessAdapter } from "@/shared/harness-events";
import { HARNESS_DIAGNOSTIC_ERROR_TYPES } from "@/shared/harness-diagnostics";
import { HarnessDiagnosticCodeSchema, HarnessDiagnosticSchema } from "@/contracts/schemas/harness-diagnostics";
import { DomainError } from "../domain/domain-error";
import { HarnessError } from "./harness-errors";

const log = createLogger("harness-diagnostics");

function ownField(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return;
  const property = Object.getOwnPropertyDescriptor(value, key);
  return property && "value" in property ? property.value : undefined;
}

export function readHarnessDiagnostic(details: unknown): HarnessDiagnostic | undefined {
  const parsed = HarnessDiagnosticSchema.safeParse(ownField(details, "diagnostic"));
  return parsed.success ? parsed.data : undefined;
}

export function harnessDiagnostic(error: unknown, context: {
  adapter?: HarnessAdapter; operation: string; details?: Readonly<Record<string, unknown>>;
}): HarnessDiagnostic {
  const previous = readHarnessDiagnostic(context.details)
    ?? (error instanceof DomainError ? readHarnessDiagnostic(error.details) : undefined);
  if (previous) return !previous.adapter && context.adapter ? { ...previous, adapter: context.adapter } : previous;
  const causes: HarnessDiagnostic["causes"] = [];
  const seen = new Set<unknown>();
  const pending = [error];
  while (pending.length && causes.length < 4) {
    const current = pending.shift();
    if (seen.has(current)) continue;
    seen.add(current);
    const field = (key: string): unknown => ownField(current, key);
    const name = field("name") ?? (
      current instanceof TypeError ? "TypeError" : current instanceof RangeError ? "RangeError"
        : current instanceof SyntaxError ? "SyntaxError" : current instanceof AggregateError ? "AggregateError" : "Error"
    );
    const type = current instanceof Error
      ? HARNESS_DIAGNOSTIC_ERROR_TYPES.find((type) => type === name) ?? "Error" : "NonError";
    const parsedCode = HarnessDiagnosticCodeSchema.safeParse(field("code"));
    const details = field("details") ?? (causes.length === 0 ? context.details : undefined);
    const nativeCode = HarnessDiagnosticSchema.shape.causes.element.shape.nativeCode.safeParse(
      ownField(details, "nativeCode") ?? ownField(details, "errorCode") ?? ownField(details, "errorType"),
    );
    const rpcCode = field("rpcCode") ?? field("code");
    const status = field("status") ?? field("statusCode") ?? ownField(details, "status");
    const method = HarnessDiagnosticSchema.shape.causes.element.shape.method.safeParse(field("method"));
    const stack = field("stack");
    // Keep source locations, never the stack's message line, user paths or SDK payloads.
    const frames = typeof stack === "string" ? stack.slice(0, 16_384).split("\n").slice(1).flatMap((line) => {
      const match = /(?:\/|\\)([a-zA-Z0-9_-]+(?:\.[cm]?[jt]sx?)?):([0-9]+)(?::([0-9]+))?\)?$/.exec(line.trim());
      const location = match ? `${match[1]}:${match[2]}${match[3] ? `:${match[3]}` : ""}` : undefined;
      return location && location.length <= 120 ? [location] : [];
    }).slice(0, 6) : [];
    causes.push({
      type, frames,
      ...(parsedCode.success ? { code: parsedCode.data } : {}),
      ...(nativeCode.success && nativeCode.data ? { nativeCode: nativeCode.data } : {}),
      ...(typeof rpcCode === "number" && Number.isSafeInteger(rpcCode) ? { rpcCode } : {}),
      ...(typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}),
      ...(method.success && method.data ? { method: method.data } : {}),
    });
    const cause = field("cause");
    if (cause !== undefined) pending.push(cause);
    const errors = field("errors");
    if (current instanceof AggregateError && Array.isArray(errors)) pending.push(...errors.slice(0, 4));
  }
  return {
    id: crypto.randomUUID(), timestamp: new Date().toISOString(),
    operation: context.operation, ...(context.adapter ? { adapter: context.adapter } : {}), causes,
  };
}

export function logHarnessFailure(error: unknown, context: {
  adapter?: HarnessAdapter; operation: string; details?: Readonly<Record<string, unknown>>;
  chatId?: string; conversationId?: string; requestId?: string; inputId?: string;
  leaseSessionId?: string; executionNodeId?: string;
}, level: "warn" | "error" = "error"): HarnessDiagnostic {
  const diagnostic = harnessDiagnostic(error, context);
  log[level]("Native harness operation failed", {
    diagnostic,
    ...(context.chatId ? { chatId: context.chatId } : {}),
    ...(context.conversationId ? { conversationId: context.conversationId } : {}),
    ...(context.requestId ? { requestId: context.requestId } : {}),
    ...(context.inputId ? { inputId: context.inputId } : {}),
    ...(context.leaseSessionId ? { leaseSessionId: context.leaseSessionId } : {}),
    ...(context.executionNodeId ? { executionNodeId: context.executionNodeId } : {}),
  });
  return diagnostic;
}

export function withHarnessDiagnostic(error: unknown, context: Parameters<typeof logHarnessFailure>[1]): DomainError {
  const diagnostic = logHarnessFailure(error, context);
  const details = { ...(error instanceof DomainError ? error.details : {}), diagnostic };
  if (error instanceof HarnessError) return new HarnessError(error.code, error.message, { cause: error, details });
  if (error instanceof DomainError) return new DomainError(error.code, error.message, { cause: error, details });
  return new HarnessError("harness_request_failed",
    error instanceof Error ? error.message : "The native runtime operation failed.", { cause: error, details });
}

export async function runHarnessOperation<T>(context: Parameters<typeof logHarnessFailure>[1], run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (error) { throw withHarnessDiagnostic(error, context); }
}
