import { z } from "zod";
import { COMMAND_EXECUTION_STATES } from "@/shared/job-execution";
import { WORKER_UPDATE_MODES } from "@/shared/worker-update";

const RequiredStringSchema = z.string().trim().min(1);
const TimestampSchema = z.string().datetime();

export const WorkerUpdateModeSchema = z.enum(WORKER_UPDATE_MODES);
export const WorkerReleaseChannelSchema = z.enum(["stable", "latest"]);
export const WorkerUpdatePreferencesSchema = z.object({
  mode: WorkerUpdateModeSchema,
  defaultChannel: WorkerReleaseChannelSchema,
});
export const StartWorkerUpdatesRequestSchema = z.object({
  channel: WorkerUpdateModeSchema.optional(),
});

export const WorkerUpdateJobStatusSchema = z.enum([
  "pending",
  "connecting",
  "running",
  "verifying",
  "completed",
  "not_started",
  "connection_failed",
  "failed",
  "interrupted",
  "unconfirmed",
]);

export const WorkerUpdateStepSchema = z.enum(["update", "restart"]);

export const WorkerUpdateStepStatusSchema = z.enum([
  "pending",
  "connecting",
  "running",
  "verifying",
  "succeeded",
  "not_started",
  "connection_failed",
  "failed",
  "interrupted",
  "skipped",
  "unconfirmed",
]);

export const WorkerUpdateJobErrorSchema = z.object({
  code: RequiredStringSchema,
  message: RequiredStringSchema,
  step: WorkerUpdateStepSchema.optional(),
});

export const WorkerUpdateStepResultSchema = z.object({
  status: WorkerUpdateStepStatusSchema,
  execution: z.enum(COMMAND_EXECUTION_STATES).optional(),
  startedAt: TimestampSchema.optional(),
  completedAt: TimestampSchema.optional(),
  exitCode: z.number().int().optional(),
  error: RequiredStringSchema.optional(),
});

export const WorkerUpdateJobSchema = z.object({
  config: z.object({
    id: RequiredStringSchema,
    workerNodeId: RequiredStringSchema,
    workerName: RequiredStringSchema,
    channel: WorkerUpdateModeSchema.default("default"),
    createdAt: TimestampSchema,
  }),
  state: z.object({
    status: WorkerUpdateJobStatusSchema,
    currentStep: WorkerUpdateStepSchema.nullable(),
    steps: z.object({
      update: WorkerUpdateStepResultSchema,
      restart: WorkerUpdateStepResultSchema,
    }),
    error: WorkerUpdateJobErrorSchema.optional(),
    startedAt: TimestampSchema.optional(),
    completedAt: TimestampSchema.optional(),
    updatedAt: TimestampSchema,
  }),
});

export const WorkerUpdateLogEntrySchema = z.object({
  id: RequiredStringSchema,
  source: z.enum(["stdout", "stderr", "system"]),
  text: z.string(),
  timestamp: TimestampSchema,
  step: WorkerUpdateStepSchema.optional(),
});

export const WorkerUpdateJobSnapshotSchema = z.object({
  job: WorkerUpdateJobSchema,
  logs: z.array(WorkerUpdateLogEntrySchema),
});

export const WorkerUpdateJobsResponseSchema = z.object({
  jobs: z.array(WorkerUpdateJobSchema),
});

const WorkerUpdateJobStartedSchema = z.object({
  workerNodeId: RequiredStringSchema,
  workerName: RequiredStringSchema,
  status: z.literal("started"),
  jobId: RequiredStringSchema,
});

const WorkerUpdateJobAdmissionFailureSchema = z.object({
  workerNodeId: RequiredStringSchema,
  workerName: RequiredStringSchema,
  status: z.literal("failed"),
  error: RequiredStringSchema,
});

const WorkerUpdateJobAlreadyActiveSchema = z.object({
  workerNodeId: RequiredStringSchema,
  workerName: RequiredStringSchema,
  status: z.literal("not_started"),
  reason: z.literal("already_active"),
  message: z.literal("An update job is already pending or running for this worker."),
});

export const StartWorkerUpdatesResponseSchema = z.object({
  success: z.literal(true),
  totalWorkers: z.number().int().nonnegative(),
  results: z.array(z.discriminatedUnion("status", [
    WorkerUpdateJobStartedSchema,
    WorkerUpdateJobAdmissionFailureSchema,
    WorkerUpdateJobAlreadyActiveSchema,
  ])),
});

export const DismissWorkerUpdateJobResponseSchema = z.object({
  success: z.literal(true),
  dismissed: z.literal(true),
});
