/**
 * Zod schemas for loop-related API requests.
 *
 * These schemas validate request bodies for loop CRUD and control operations.
 * They match the interfaces defined in types/api.ts.
 *
 * @module types/schemas/loop
 */

import { z } from "zod";
import { normalizeCommitScope } from "../../utils/commit-scope";
import { CheapModelSelectionSchema, ModelConfigSchema } from "./model";
import {
  MESSAGE_IMAGE_ATTACHMENT_LIMIT,
  MESSAGE_IMAGE_ATTACHMENT_MAX_BYTES,
  MESSAGE_IMAGE_ALLOWED_MIME_TYPES,
} from "../message-attachments";

/**
 * Approximate the decoded byte size of a base64 string.
 * base64 encodes 3 bytes into 4 characters, plus optional padding.
 */
function approximateBase64DecodedSize(base64: string): number {
  const len = base64.length;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor(((len * 3) / 4) - padding);
}

const allowedMimeTypes = MESSAGE_IMAGE_ALLOWED_MIME_TYPES as readonly string[];

export const MessageImageAttachmentSchema = z.object({
  id: z.string().min(1, "attachment id is required"),
  filename: z.string().min(1, "attachment filename is required"),
  mimeType: z.string().refine(
    (mime) => allowedMimeTypes.includes(mime),
    { message: `attachments must be one of: ${MESSAGE_IMAGE_ALLOWED_MIME_TYPES.join(", ")}` },
  ),
  data: z.string().min(1, "attachment data is required").refine(
    (data) => approximateBase64DecodedSize(data) <= MESSAGE_IMAGE_ATTACHMENT_MAX_BYTES,
    { message: `attachment data exceeds ${MESSAGE_IMAGE_ATTACHMENT_MAX_BYTES} bytes` },
  ),
  size: z.number().int().positive().max(
    MESSAGE_IMAGE_ATTACHMENT_MAX_BYTES,
    `attachments must be ${MESSAGE_IMAGE_ATTACHMENT_MAX_BYTES} bytes or smaller`,
  ),
});

export const MessageImageAttachmentsSchema = z
  .array(MessageImageAttachmentSchema)
  .max(MESSAGE_IMAGE_ATTACHMENT_LIMIT, `no more than ${MESSAGE_IMAGE_ATTACHMENT_LIMIT} images can be attached`);

/**
 * Schema for GitConfig - git integration settings.
 * Used as a partial in CreateLoopRequest and UpdateLoopRequest.
 *
 * Accepts `commitScope` (preferred) or `commitPrefix` (deprecated alias).
 * If both are provided, `commitScope` takes precedence.
 */
export const GitConfigSchema = z.object({
  branchPrefix: z.string(),
  commitScope: z.string(),
}).transform((val) => {
  const toConfiguredCommitScope = (scope: string): string => {
    return normalizeCommitScope(scope) ?? "";
  };
  return {
    branchPrefix: val.branchPrefix,
    commitScope: toConfiguredCommitScope(val.commitScope),
  };
});

export const LoopNameSchema = z
  .string()
  .trim()
  .min(1, "name is required")
  .max(100, "name cannot exceed 100 characters");

const ActivityTimeoutSecondsSchema = z
  .number()
  .min(60, "activityTimeoutSeconds must be at least 60 seconds")
  .nullable();

/**
 * Schema for CreateLoopRequest - POST /api/loops
 *
 */
export const CreateLoopRequestSchema = z.object({
  name: LoopNameSchema,
  workspaceId: z.string().min(1, "workspaceId is required"),
  prompt: z.string().min(1, "prompt is required and must be a non-empty string"),
  attachments: MessageImageAttachmentsSchema,
  model: ModelConfigSchema,
  cheapModel: CheapModelSelectionSchema,
  maxIterations: z.number().positive().nullable(),
  maxConsecutiveErrors: z.number(),
  activityTimeoutSeconds: ActivityTimeoutSecondsSchema.optional(),
  stopPattern: z.string(),
  git: GitConfigSchema,
  baseBranch: z.string().min(1, "baseBranch is required"),
  useWorktree: z.boolean({ error: "useWorktree is required and must be a boolean (true or false)" }),
  clearPlanningFolder: z.boolean(),
  planMode: z.boolean({ error: "planMode is required and must be a boolean (true or false)" }),
  autoAcceptPlan: z.boolean(),
  fullyAutonomous: z.boolean(),
  draft: z.boolean(),
});

/**
 * Schema for UpdateLoopRequest - PATCH /api/loops/:id
 *
 * All fields are optional. Name updates are accepted only for draft loops;
 * that state-based restriction is enforced by the loop update service.
 */
export const UpdateLoopRequestSchema = z.object({
  name: LoopNameSchema.optional(),
  directory: z.string().optional(),
  prompt: z.string().optional(),
  model: ModelConfigSchema.optional(),
  cheapModel: CheapModelSelectionSchema.optional(),
  maxIterations: z.number().positive().nullable().optional(),
  maxConsecutiveErrors: z.number().optional(),
  activityTimeoutSeconds: ActivityTimeoutSecondsSchema.optional(),
  stopPattern: z.string().optional(),
  git: GitConfigSchema.optional(),
  baseBranch: z.string().optional(),
  useWorktree: z.boolean().optional(),
  clearPlanningFolder: z.boolean().optional(),
  planMode: z.boolean().optional(),
  autoAcceptPlan: z.boolean().optional(),
  fullyAutonomous: z.boolean().optional(),
});

/**
 * Schema for explicit AI title generation - POST /api/loops/title
 */
export const GenerateLoopTitleRequestSchema = z.object({
  workspaceId: z.string().min(1, "workspaceId is required"),
  prompt: z.string().trim().min(1, "prompt is required and must be a non-empty string"),
  model: ModelConfigSchema,
  cheapModel: CheapModelSelectionSchema,
});

/**
 * Schema for AddressCommentsRequest - POST /api/loops/:id/address-comments
 */
export const AddressCommentsRequestSchema = z.object({
  comments: z.string().refine((val) => val.trim().length > 0, {
    message: "comments cannot be empty",
  }),
  attachments: MessageImageAttachmentsSchema,
});

/**
 * Schema for plan feedback - POST /api/loops/:id/plan/feedback
 */
export const PlanFeedbackRequestSchema = z.object({
  feedback: z.string().refine((val) => val.trim().length > 0, {
    message: "feedback cannot be empty",
  }),
  attachments: MessageImageAttachmentsSchema,
});

/**
 * Schema for plan acceptance - POST /api/loops/:id/plan/accept
 */
export const PlanAcceptRequestSchema = z.object({
  mode: z.enum(["start_loop", "open_ssh"]),
});

/**
 * Schema for pending prompt - PUT /api/loops/:id/pending-prompt
 */
export const PendingPromptRequestSchema = z.object({
  prompt: z.string().refine((val) => val.trim().length > 0, {
    message: "prompt is required and cannot be empty or whitespace-only",
  }),
  attachments: MessageImageAttachmentsSchema,
});

/**
 * Schema for set pending - POST /api/loops/:id/pending
 * Queueing is no longer supported. The endpoint accepts the legacy
 * `immediate` field for validation/backward compatibility, but callers must
 * send `true` or omit it entirely.
 */
export const SetPendingRequestSchema = z.object({
  message: z.string().nullable(),
  model: ModelConfigSchema.nullable(),
  immediate: z.boolean(),
  attachments: MessageImageAttachmentsSchema,
});

/**
 * Schema for starting a draft - POST /api/loops/:id/draft/start
 */
export const StartDraftRequestSchema = z.object({
  planMode: z.boolean({ error: "planMode is required" }),
  attachments: MessageImageAttachmentsSchema,
});

/**
 * Schema for sending a terminal-state follow-up - POST /api/loops/:id/follow-up
 */
export const FollowUpRequestSchema = z.object({
  message: z.string().refine((val) => val.trim().length > 0, {
    message: "message cannot be empty",
  }),
  model: ModelConfigSchema.nullable(),
  attachments: MessageImageAttachmentsSchema,
});
