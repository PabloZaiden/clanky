export interface PromptTemplate {
  id: string;
  name: string;
  description: string;
  prompt: string;
}

export interface PromptTemplatePreferences {
  templates: PromptTemplate[];
  planningTemplateEnabled: boolean;
  planningTemplateIndex: number;
}

const PLANNING_INSTRUCTIONS = [
  "Investigate the project and ask clarifying questions as needed. Create .clanky-planning/plan.md with verifiable goals and .clanky-planning/status.md with progress, remaining work, blockers, and next steps.",
  "Discuss and revise the plan through this same ordinary conversation. Wait for an explicit user request before implementing; do not treat planning or discussion as permission to implement.",
  "During subsequent implementation, keep status.md current and update it before reporting results.",
].join("\n");

export const INITIAL_PLANNING_GUIDANCE = `Start with a plan for the user's request below.\n${PLANNING_INSTRUCTIONS}`;

export const PREPARE_PLAN_TEMPLATE: PromptTemplate = {
  id: "clanky:prepare-plan",
  name: "Prepare a plan",
  description: "Plan from this conversation and wait for an explicit request to implement.",
  prompt: [
    "Prepare a plan using our conversation so far and any requirements below.",
    "Record what is already done and what remains; do not restart completed work.",
    PLANNING_INSTRUCTIONS,
  ].join("\n"),
};

export function getOrderedPromptTemplates({ templates, planningTemplateIndex }: PromptTemplatePreferences) {
  const ordered = templates.map((template) => ({ value: `custom:${template.id}`, template }));
  ordered.splice(Math.min(planningTemplateIndex, ordered.length), 0, {
    value: PREPARE_PLAN_TEMPLATE.id,
    template: PREPARE_PLAN_TEMPLATE,
  });
  return ordered;
}

export const PROMPT_TEMPLATES_REALTIME_RESOURCE = "prompt-templates";

export const PROMPT_TEMPLATE_LIMITS = {
  count: 100,
  nameLength: 120,
  descriptionLength: 500,
  promptLength: 50_000,
} as const;
