/**
 * Authenticated media diagnostic ingestion into the existing server logger.
 */

import { createLogger } from "@pablozaiden/webapp/server";
import type { LiveAudioDiagnosticsRequest } from "@/contracts/schemas/live-voice-audio";
import { requireCurrentUser } from "../context/user-context";
import { DomainError } from "../domain/domain-error";

const log = createLogger("core:live-audio");
const WINDOW_MS = 60_000;
const MAX_BATCHES_PER_WINDOW = 60;
const MAX_TRACKED_USERS = 256;

export class LiveVoiceAudioDiagnosticLog {
  private readonly windows = new Map<string, { started: number; count: number }>();

  record(input: LiveAudioDiagnosticsRequest): { accepted: number; lastSequence: number } {
    const userId = requireCurrentUser().id;
    this.admit(userId);
    const correlation = {
      userId, clientId: input.clientId, attemptId: input.attemptId, callId: input.callId,
      droppedRecords: input.droppedRecords, deliveryFailures: input.deliveryFailures,
    };
    for (const record of input.records) {
      const failed = ["play_failed", "microphone_failed", "microphone_ended", "audio_error"].includes(record.event);
      const degraded = ["stats_failed", "buffer_failed", "context_resume_failed", "delivery_failed"].includes(record.event)
        || record.event === "buffer_unsupported" && record.media.requestedTargetMs !== null;
      const level = failed ? "error" : degraded ? "warn" : "info";
      log[level]("Live audio diagnostic", { ...correlation, ...record });
    }
    return { accepted: input.records.length, lastSequence: input.records.at(-1)!.sequence };
  }

  private admit(userId: string): void {
    const now = Date.now();
    for (const [id, window] of this.windows) {
      if (now - window.started >= WINDOW_MS) this.windows.delete(id);
    }
    let window = this.windows.get(userId);
    if (!window) {
      if (this.windows.size >= MAX_TRACKED_USERS) this.rateLimited();
      window = { started: now, count: 0 };
      this.windows.set(userId, window);
    }
    if (window.count >= MAX_BATCHES_PER_WINDOW) this.rateLimited();
    window.count += 1;
  }

  private rateLimited(): never {
    throw new DomainError("voice_audio_diagnostics_rate_limited", "Audio diagnostic capacity is in use.", {
      details: { retryAfter: "5" },
    });
  }

  dispose(): void { this.windows.clear(); }
}
