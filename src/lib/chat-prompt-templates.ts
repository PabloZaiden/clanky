/**
 * Prompt templates for chat messages.
 */

/** A predefined prompt template for chat composition. */
export interface ChatPromptTemplate {
  /** Unique identifier for the template. */
  id: string;
  /** Short display name shown in the dropdown. */
  name: string;
  /** Brief description shown as helper text when the template is selected. */
  description: string;
  /** The full prompt text that autofills the chat composer. */
  prompt: string;
}

/** Predefined prompt templates for chats. */
export const CHAT_PROMPT_TEMPLATES: readonly ChatPromptTemplate[] = [
  {
    id: "project-analysis",
    name: "Project Analysis",
    description:
      "Analyzes the whole project and produces detailed architecture and state diagrams.",
    prompt: `Analyze this entire project in detail.

Your goal is to understand the full codebase and produce a comprehensive project analysis. Inspect the repository structure, source code, tests, configuration, documentation, and any important generated or support files.

Produce a detailed explanation that covers:

1. **Project purpose**
   - What the project does
   - Who or what it is for
   - The main user workflows and supported capabilities

2. **Architecture**
   - The major modules, layers, services, components, and data stores
   - How the frontend, backend, persistence, background processes, and external integrations fit together
   - Important boundaries, responsibilities, and dependencies between modules

3. **Data and control flow**
   - How important requests, events, jobs, or commands move through the system
   - How state is created, updated, persisted, synchronized, and displayed
   - Any important lifecycle or error-handling flows

4. **Architecture diagrams**
   - Generate clear Mermaid diagrams for the overall system architecture
   - Add additional diagrams for major subsystems when helpful
   - Include enough labels that someone new to the project can understand the relationships

5. **State diagrams**
   - Generate Mermaid state diagrams for the important domain objects and workflows
   - Include key states, transitions, triggers, and terminal/error states

6. **Implementation notes**
   - Call out important conventions, abstractions, extension points, and operational assumptions
   - Mention notable risks, complexity hotspots, or areas that deserve deeper follow-up

Be thorough and concrete. Reference specific files and directories where they clarify the explanation. Prefer accurate, evidence-based analysis over speculation.`,
  },
] as const;

/** Find a chat template by its ID. */
export function getChatTemplateById(id: string): ChatPromptTemplate | undefined {
  return CHAT_PROMPT_TEMPLATES.find((template) => template.id === id);
}
