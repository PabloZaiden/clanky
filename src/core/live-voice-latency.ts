/**
 * Content-free timing for one delegated turn and its local tool executions.
 */

import { createLogger } from "@pablozaiden/webapp/server";
import { readRevision } from "../client-sdk/collaboration/resource-read";

const log = createLogger("core:live-voice-latency");

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function counter(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function textResponseUsage(value: unknown) {
  const usage = record(record(value)?.["usage"]);
  const outputDetails = record(usage?.["output_tokens_details"]);
  return {
    inputTokens: counter(usage?.["input_tokens"]),
    outputTokens: counter(usage?.["output_tokens"]),
    reasoningTokens: counter(outputDetails?.["reasoning_tokens"]),
  };
}

function duration(start: number): number {
  return Math.round((performance.now() - start) * 10) / 10;
}

export class LiveVoiceLatency {
  private readonly startedAt = performance.now();
  private readonly correlation: { callId: string; delegationIdHash: string };
  private responseId?: string;
  private responseStartedAt = this.startedAt;
  private continuationAt?: number;
  private firstOutput = false;
  private ended = false;
  private round = 0;
  private tools = 0;
  private toolMs = 0;

  constructor(callId: string, delegationId: string) {
    this.correlation = { callId, delegationIdHash: readRevision(delegationId) };
    log.info("Live delegation started", this.correlation);
  }

  responseStarted(responseId: string): void {
    if (this.responseId === responseId) return;
    this.responseId = responseId;
    this.round += 1;
    this.responseStartedAt = performance.now();
    this.firstOutput = false;
    log.info("Live text response started", {
      ...this.correlation, round: this.round,
      admissionMs: duration(this.continuationAt ?? this.startedAt),
      reasoningEffort: "none",
    });
    this.continuationAt = undefined;
  }

  outputStarted(): void {
    if (this.firstOutput) return;
    this.firstOutput = true;
    log.info("Live text first output", {
      ...this.correlation, round: this.round, modelMs: duration(this.responseStartedAt),
    });
  }

  responseCompleted(response: unknown, tools: number): void {
    log.info("Live text response completed", {
      ...this.correlation, round: this.round, modelMs: duration(this.responseStartedAt),
      functionCalls: tools, ...textResponseUsage(response),
    });
  }

  toolStarted(input: { requestId: string; tool: string; queuedAt: number }): (result: {
    ok: boolean; operationId?: string; wireBytes?: number;
  }) => void {
    const startedAt = performance.now();
    const correlation = {
      ...this.correlation, round: this.round,
      requestIdHash: readRevision(input.requestId), tool: input.tool,
    };
    this.tools += 1;
    log.info("Live tool started", { ...correlation, queueMs: duration(input.queuedAt) });
    return (result): void => {
      const toolMs = duration(startedAt);
      this.toolMs += toolMs;
      log.info("Live tool completed", { ...correlation, ...result, toolMs });
    };
  }

  continued(items: number, wireBytes: number): void {
    this.continuationAt = performance.now();
    log.info("Live tool batch continued", {
      ...this.correlation, round: this.round, items, wireBytes,
    });
  }

  finish(completed: boolean): void {
    if (this.ended) return;
    this.ended = true;
    log.info("Live delegation ended", {
      ...this.correlation, completed, rounds: this.round, tools: this.tools,
      elapsedMs: duration(this.startedAt), toolMs: this.toolMs,
    });
  }
}
