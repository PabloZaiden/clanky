import { provisioningEventEmitter } from "../event-emitter";
import type { ProvisioningLogEntry, ProvisioningStep } from "@/shared";
import type { ProvisioningJobRecord } from "./types";

export function appendLog(
  record: ProvisioningJobRecord,
  maxLogEntries: number,
  source: ProvisioningLogEntry["source"],
  text: string,
  step?: ProvisioningStep,
): void {
  if (!text) {
    return;
  }

  const entry: ProvisioningLogEntry = {
    id: crypto.randomUUID(),
    source,
    text,
    timestamp: new Date().toISOString(),
    ...(step ? { step } : {}),
  };
  record.logs.push(entry);
  if (record.logs.length > maxLogEntries) {
    record.logs.splice(0, record.logs.length - maxLogEntries);
  }
  provisioningEventEmitter.emit({
    type: "provisioning.output",
    provisioningJobId: record.job.config.id,
    entry,
    timestamp: entry.timestamp,
  });
}

export function appendSystemLog(
  record: ProvisioningJobRecord,
  maxLogEntries: number,
  text: string,
  step?: ProvisioningStep,
): void {
  appendLog(record, maxLogEntries, "system", text, step);
}

export function setStep(
  record: ProvisioningJobRecord,
  maxLogEntries: number,
  step: ProvisioningStep,
  message?: string,
): void {
  const now = new Date().toISOString();
  record.job.state = {
    ...record.job.state,
    status: "running",
    currentStep: step,
    startedAt: record.job.state.startedAt ?? now,
    updatedAt: now,
  };
  if (message) {
    appendSystemLog(record, maxLogEntries, message, step);
  }
  provisioningEventEmitter.emit({
    type: "provisioning.step",
    provisioningJobId: record.job.config.id,
    job: structuredClone(record.job),
    step,
    message,
    timestamp: record.job.state.updatedAt,
  });
}
