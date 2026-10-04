/**
 * Validates provider-neutral answers before any irreversible native admission.
 */

import type { QuestionInfo } from "@/shared/harness-events";
import { HarnessError } from "../backends/harness-errors";

export function validateQuestionAnswers(questions: readonly QuestionInfo[], answers: string[][]): void {
  if (answers.length !== questions.length) throw new HarnessError("harness_question_invalid", "Answer every question in the request.");
  for (const [index, question] of questions.entries()) {
    const values = answers[index]!;
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
