import { z } from "zod";
import {
  getBase64DecodedByteLength,
  getMessageAttachmentKind,
  getMessageAttachmentByteLength,
  isValidAttachmentBase64,
  MESSAGE_ATTACHMENT_LIMIT,
  MESSAGE_ATTACHMENT_MAX_BYTES,
  MESSAGE_ATTACHMENT_MAX_TURN_BYTES,
  MESSAGE_ATTACHMENT_MAX_TURN_MIB,
} from "@/shared";

export const MessageAttachmentSchema = z.object({
  id: z.string().min(1, "attachment id is required"),
  filename: z.string().min(1, "attachment filename is required"),
  mimeType: z.string().trim().default("").transform((value) => value || "application/octet-stream"),
  data: z.string().max(Math.ceil(MESSAGE_ATTACHMENT_MAX_BYTES / 3) * 4).refine(
    (data) => getBase64DecodedByteLength(data) <= MESSAGE_ATTACHMENT_MAX_BYTES,
    { message: `attachment data exceeds ${MESSAGE_ATTACHMENT_MAX_BYTES} bytes` },
  ).refine(isValidAttachmentBase64, { message: "attachment data must be valid base64" }),
  size: z.number().int().nonnegative().max(
    MESSAGE_ATTACHMENT_MAX_BYTES,
    `attachments must be ${MESSAGE_ATTACHMENT_MAX_BYTES} bytes or smaller`,
  ),
}).superRefine((attachment, ctx) => {
  if (getBase64DecodedByteLength(attachment.data) !== attachment.size) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["size"],
      message: "attachment size must match its decoded bytes",
    });
  }
  if (getMessageAttachmentKind(attachment) === "image" && attachment.size === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["data"],
      message: "image attachments must not be empty",
    });
  }
});

export const MessageAttachmentsSchema = z
  .array(MessageAttachmentSchema)
  .max(MESSAGE_ATTACHMENT_LIMIT, `no more than ${MESSAGE_ATTACHMENT_LIMIT} attachments can be attached`)
  .superRefine((attachments, ctx) => {
    if (getMessageAttachmentByteLength(attachments) > MESSAGE_ATTACHMENT_MAX_TURN_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `attachments cannot exceed ${MESSAGE_ATTACHMENT_MAX_TURN_MIB} MiB in a single turn`,
      });
    }
  });

export const ProviderImageAttachmentSchema = MessageAttachmentSchema.safeExtend({
  data: z.string().refine(isValidAttachmentBase64, { message: "attachment data must be valid base64" }),
  size: z.number().int().nonnegative(),
});

export const EntityNameSchema = z
  .string()
  .trim()
  .min(1, "name is required")
  .max(100, "name cannot exceed 100 characters");
