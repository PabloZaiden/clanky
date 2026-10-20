export interface PromptTemplate {
  id: string;
  name: string;
  description: string;
  prompt: string;
}

export const PROMPT_TEMPLATES_REALTIME_RESOURCE = "prompt-templates";

export const PROMPT_TEMPLATE_LIMITS = {
  count: 100,
  nameLength: 120,
  descriptionLength: 500,
  promptLength: 50_000,
} as const;
