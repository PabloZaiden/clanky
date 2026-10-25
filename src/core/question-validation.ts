/**
 * Validates provider-neutral answers before any irreversible native admission.
 */

import type { QuestionInfo } from "@/shared/harness-events";
import { HarnessError } from "../backends/harness-errors";
import {
  getMessageAttachmentKind,
  getMessageAttachmentByteLength,
  MESSAGE_ATTACHMENT_LIMIT,
  MESSAGE_ATTACHMENT_MAX_TURN_BYTES,
  type MessageAttachment,
} from "@/shared/message-attachments";

export function validateQuestionAnswers(
  questions: readonly QuestionInfo[],
  answers: string[][],
  attachments: readonly MessageAttachment[][] = [],
): void {
  if (answers.length !== questions.length) throw new HarnessError("harness_question_invalid", "Answer every question in the request.");
  const images = attachments.flat();
  if ((attachments.length && attachments.length !== questions.length)
    || images.length > MESSAGE_ATTACHMENT_LIMIT
    || getMessageAttachmentByteLength(images) > MESSAGE_ATTACHMENT_MAX_TURN_BYTES
    || new Set(images.map((image) => image.id)).size !== images.length
    || images.some((image) => getMessageAttachmentKind(image) !== "image")) {
    throw new HarnessError("harness_question_invalid", "The answer images do not match the question request or attachment limits.");
  }
  for (const [index, question] of questions.entries()) {
    const values = answers[index]!;
    if (attachments[index]?.length) {
      if (question.custom === false || question.valueType === "number" || question.valueType === "integer") {
        throw new HarnessError("harness_question_invalid", "Images are only supported in custom text answers.");
      }
      if (!values.length && !question.minLength && !question.minItems) continue;
    }
    if (!values.length && question.required === false) continue;
    if (!values.length || (!question.multiple && values.length !== 1)
      || new Set(values).size !== values.length || values.some((value) => !value.trim() || value.length > 10_000
        || (question.minLength !== undefined && value.length < question.minLength)
        || (question.maxLength !== undefined && value.length > question.maxLength))
      || (question.minItems !== undefined && values.length < question.minItems)
      || (question.maxItems !== undefined && values.length > question.maxItems)) {
      throw new HarnessError("harness_question_invalid", "The answer does not match the requested selection.");
    }
    const choices = new Set(question.options.map((option) => option.label));
    if (question.custom === false && values.some((value) => !choices.has(value))) {
      throw new HarnessError("harness_question_invalid", "Select one of the offered answers.");
    }
    if (question.valueType === "number" || question.valueType === "integer") {
      const number = Number(values[0]);
      if (!Number.isFinite(number) || (question.valueType === "integer" && !Number.isInteger(number))
        || (question.minimum !== undefined && number < question.minimum)
        || (question.maximum !== undefined && number > question.maximum)) {
        throw new HarnessError("harness_question_invalid", "The numeric answer is outside the permitted range.");
      }
    }
  }
}
