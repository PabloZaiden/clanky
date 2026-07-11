/**
 * Prompt templates for task creation and chat composition.
 *
 * Each template provides a predefined prompt that can be selected from
 * task creation or chat composition. Templates may also specify
 * task-only default form values (e.g., planMode) that are applied only
 * when selected from the task creation form.
 *
 * To add a new template, append an entry to the `PROMPT_TEMPLATES` array.
 */

/** Configuration defaults that a template can override on the form. */
export interface PromptTemplateDefaults {
  /** Whether plan mode should be enabled for this template. */
  planMode?: boolean;
}

/** A predefined prompt template shared by task creation and chat composition. */
export interface PromptTemplate {
  /** Unique identifier for the template. */
  id: string;
  /** Short display name shown in the dropdown. */
  name: string;
  /** Brief description shown as helper text when the template is selected. */
  description: string;
  /** The full prompt text that autofills the textarea. */
  prompt: string;
  /** Optional task form defaults applied when selected from task creation. */
  taskDefaults?: PromptTemplateDefaults;
}

/**
 * Predefined prompt templates.
 *
 * Add new templates by appending to this array. Each template must have
 * a unique `id`. The order here determines the order in the dropdown.
 */
export const PROMPT_TEMPLATES: readonly PromptTemplate[] = [
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
  {
    id: "thorough-code-review",
    name: "Thorough Code Review",
    description:
      "Analyzes code quality and maintainability and produces one consolidated list of findings.",
    prompt: `Run a detailed analysis with the goal of improving the code quality and maintainability of this solution.
Focus on hacky parts, repeated code hardcoded or fragile implementations.
Regarding automated tests, less is more. Flag any test that just checks for the exact implementation, the absence of old behavior already changed, specific strings or ui things. We want to test proper behavior, not small tests for regressions already fixed or ui details that will fail if the ui changes.

After finishing the whole analysis and reviewing the findings, make a single clean, complete and detailed list with all the findings.`,
    taskDefaults: {
      planMode: true,
    },
  },
  {
    id: "fix-failing-tests",
    name: "Fix Failing Tests",
    description:
      "Runs the test suite and iteratively fixes code until all tests pass.",
    prompt: `Run the full test suite and fix any failing tests.

**Approach:**
1. Run \`bun run build\` first to check for build/type errors — fix any that appear
2. Run \`bun run test\` to identify all failing tests
3. For each failing test, analyze the failure to determine if the issue is in the application code or the test itself
4. Fix the application code to make tests pass — prefer fixing code over fixing tests
5. If a test is genuinely wrong (testing incorrect behavior), fix the test and document why
6. Re-run the full test suite after each batch of fixes to verify no regressions
7. Repeat until all tests pass

**Rules:**
- Always fix code to match test expectations, unless the test is clearly wrong
- Never delete or skip tests to make the suite pass
- Run the full suite (not individual tests) for final verification
- Follow the project's existing coding conventions`,
    taskDefaults: {
      planMode: false,
    },
  },
  {
    id: "continue-planned-tasks",
    name: "Continue Planned Tasks",
    description:
      "Reads the .clanky-planning/ folder and continues executing the next pending task.",
    prompt: `Continue working on the planned tasks.

Read \`.clanky-planning/plan.md\` for the full plan and \`.clanky-planning/status.md\` for current progress. Pick up the next pending task and continue implementation.

Follow the standard workflow in the planning files — update status after each completed task.`,
    taskDefaults: {
      planMode: false,
    },
  },
  {
    id: "review-fix-documentation",
    name: "Review & Fix Documentation",
    description:
      "Reviews all README files, documentation, and code comments against actual code behavior and fixes any discrepancies.",
    prompt: `Review and fix all documentation in this codebase so that it accurately reflects the current code behavior. This includes README files, markdown documentation, doc comments, and significant inline comments.

**Phase 1: Discovery**
Find all documentation artifacts in the codebase:
- \`README.md\` and any other \`*.md\` files (excluding dependency directories, \`code_review/\`, and \`.clanky-planning/\`)
- Doc comment blocks (e.g., Javadoc, docstrings, GoDoc, Rustdoc, XML doc comments, or similar) on public functions, classes, and types
- Significant inline comments that describe behavior, constraints, or architecture
- Configuration file comments (e.g., build configs, project manifests, CI/CD pipelines)

**Phase 2: Analysis**
For each documentation artifact, compare its claims against the actual code:
- **API signatures** — Do documented parameters, return types, and method names match the code?
- **Usage examples** — Do code snippets in docs actually work with the current API?
- **File/folder references** — Do referenced paths still exist and point to the right things?
- **Architectural descriptions** — Do high-level descriptions match the actual module structure and data flow?
- **Command examples** — Do documented CLI commands, scripts, and flags match what the code supports?
- **Configuration docs** — Do documented config options, env vars, and defaults match the implementation?
- **Feature descriptions** — Do described features and behaviors match what the code actually does?
- **Inline comments** — Do comments above or beside code accurately describe what the code does?

**Phase 3: Fix**
Update documentation to match the code (not the other way around — the code is the source of truth):
1. Fix incorrect function/method descriptions and parameter docs
2. Update outdated usage examples and code snippets so they work with current APIs
3. Correct broken or wrong file path references
4. Update architectural descriptions that no longer match reality
5. Remove documentation for code, features, or APIs that no longer exist
6. Add brief documentation for undocumented public APIs where it improves clarity
7. Fix inline comments that describe behavior incorrectly
8. Ensure all command examples use the correct syntax and flags

**Phase 4: Verification**
After making fixes, re-read the updated documentation to confirm:
- All references to files, functions, and modules resolve correctly
- Code examples are syntactically valid and use current APIs
- No contradictions remain between different documentation files
- The documentation tells a consistent, accurate story about the codebase

**Rules:**
- The code is the source of truth — fix docs to match code, never change code to match docs
- Preserve the existing documentation style and tone
- Do not rewrite documentation that is already correct
- Do not add excessive documentation — keep it concise and useful
- Follow the project's existing conventions if they are evident in the codebase and documentation
- Run the project's build command after all changes to verify nothing is broken`,
    taskDefaults: {
      planMode: true,
    },
  },
  {
    id: "update-project-dependencies",
    name: "Update all project dependencies to the latest stable version",
    description:
      "Updates project dependencies to the latest stable versions across detected package ecosystems and verifies the result.",
    prompt: `Update all project dependencies in this repository to the latest stable versions.

**Approach:**
1. Discover every dependency manifest and lockfile in the repository, including files such as \`package.json\`, \`bun.lock\`, \`package-lock.json\`, \`pnpm-lock.yaml\`, \`yarn.lock\`, \`requirements*.txt\`, \`pyproject.toml\`, \`Pipfile\`, \`poetry.lock\`, \`Gemfile\`, \`Gemfile.lock\`, \`go.mod\`, \`Cargo.toml\`, and any other ecosystem-specific dependency files present.
2. Identify the package manager or tooling used by each ecosystem, preferring the lockfile and existing project scripts over introducing new tooling.
3. Update dependencies to the latest stable non-prerelease versions available for the existing dependency channels.
4. Include major-version updates when they are stable, but review release notes or migration guidance when available and make any required code, configuration, or test updates.
5. Regenerate or update lockfiles using the repository's existing package managers.
6. Run the project's relevant formatting, linting, build, type-check, and test commands based on the repository's existing scripts and documentation.
7. If a dependency cannot be safely updated, leave the project in a working state and document the package, attempted version, reason it is blocked, and the next action needed.

**Rules:**
- Prefer stable releases; do not upgrade to alpha, beta, rc, nightly, canary, or other prerelease versions unless the project already depends on that prerelease channel or the user explicitly requested it.
- Preserve the repository's existing package manager choices and lockfile strategy.
- Do not remove dependencies unless they are clearly obsolete as part of the update and the codebase no longer uses them.
- Do not ignore failing validation. Fix compatibility issues caused by dependency updates, or revert the specific problematic update and document why.
- Keep changes focused on dependency updates and required compatibility fixes.
- Summarize the updated dependency groups, important major-version changes, validation commands run, and any remaining blockers.`,
    taskDefaults: {
      planMode: true,
    },
  },
] as const;

/**
 * Find a template by its ID.
 * Returns undefined if no template matches.
 */
export function getTemplateById(id: string): PromptTemplate | undefined {
  return PROMPT_TEMPLATES.find((t) => t.id === id);
}
