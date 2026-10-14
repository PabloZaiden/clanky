import { z } from "zod";

const RequiredStringSchema = z.string().trim().min(1);
const TimestampSchema = z.string().datetime();

export const WorkerUpdateJobStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "interrupted",
]);

export const WorkerUpdateStepSchema = z.enum(["update", "restart"]);

export const WorkerUpdateStepStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
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

export const StartWorkerUpdatesResponseSchema = z.object({
  success: z.literal(true),
  totalWorkers: z.number().int().nonnegative(),
  results: z.array(z.discriminatedUnion("status", [
    WorkerUpdateJobStartedSchema,
    WorkerUpdateJobAdmissionFailureSchema,
  ])),
});

export const DismissWorkerUpdateJobResponseSchema = z.object({
  success: z.literal(true),
  dismissed: z.literal(true),
});
