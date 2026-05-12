/**
 * Compatibility exports for chat prompt templates.
 *
 * The canonical shared prompt template registry lives in `prompt-templates.ts`.
 */

import {
  PROMPT_TEMPLATES,
  getTemplateById,
  type PromptTemplate,
} from "./prompt-templates";

export type ChatPromptTemplate = PromptTemplate;

/** Predefined prompt templates available to chats. */
export const CHAT_PROMPT_TEMPLATES = PROMPT_TEMPLATES;

/** Find a shared template by its ID for chat composition. */
export const getChatTemplateById = getTemplateById;
