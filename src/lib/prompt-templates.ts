/**
 * Prompt templates for loop creation.
 *
 * Each template provides a predefined prompt that can be selected from
 * a dropdown in the loop creation form. Templates may also specify
 * default form values (e.g., planMode) that are applied when selected.
 *
 * To add a new template, append an entry to the `PROMPT_TEMPLATES` array.
 */

/** Configuration defaults that a template can override on the form. */
export interface PromptTemplateDefaults {
  /** Whether plan mode should be enabled for this template. */
  planMode?: boolean;
}

/** A predefined prompt template for loop creation. */
export interface PromptTemplate {
  /** Unique identifier for the template. */
  id: string;
  /** Short display name shown in the dropdown. */
  name: string;
  /** Brief description shown as helper text when the template is selected. */
  description: string;
  /** The full prompt text that autofills the textarea. */
  prompt: string;
  /** Optional form defaults applied when the template is selected. */
  defaults?: PromptTemplateDefaults;
}

/**
 * Predefined prompt templates.
 *
 * Add new templates by appending to this array. Each template must have
 * a unique `id`. The order here determines the order in the dropdown.
 */
export const PROMPT_TEMPLATES: readonly PromptTemplate[] = [
  {
    id: "thorough-code-review",
    name: "Thorough Code Review",
    description:
      "Performs a comprehensive multi-layer code review and writes results to the code_review/ folder.",
    prompt: `Perform a thorough, multi-perspective code review of this codebase. Write your findings into the \`code_review/\` folder with the following structure:

1. **\`code_review/README.md\`** — Summary & guide
   - Overall codebase health score (A through F)
   - Finding summary tables by severity (Critical, Major, Minor, Suggestion) and by dimension
   - Top 10 architectural recommendations
   - How-to-read guide pointing readers to the other documents

2. **\`code_review/layers.md\`** — Architectural layer analysis
   - Identify the architectural layers (e.g., API, Core, Persistence, Frontend, etc.)
   - Analyze each layer: responsibilities, health, dependency violations, error propagation
   - Cross-layer analysis: coupling, bypasses, data flow issues

3. **\`code_review/functionalities.md\`** — End-to-end functionality analysis
   - Trace key features across all layers from UI to database
   - Identify cross-cutting concerns (code duplication, error handling patterns, etc.)
   - Analyze data flow, state management, and integration points

4. **\`code_review/modules.md\`** — Module-level analysis
   - Review each source directory as a cohesive module
   - Assess cohesion, coupling, API surface quality, test coverage
   - Identify dead code, missing abstractions, and refactoring opportunities

5. **\`code_review/files.md\`** — File-by-file analysis
   - Detailed findings for each file with exact line numbers
   - Categorize by dimensions: correctness, error handling, type safety, complexity, naming, duplication, performance, security
   - Each finding should include severity, description, and suggested fix

**Guidelines:**
- Be thorough and specific — reference exact file paths and line numbers
- Prioritize actionable findings over style nitpicks
- Use severity levels consistently: Critical (data loss, security), Major (correctness, maintainability), Minor (style, convention), Suggestion (improvements)
- Cross-reference findings across documents where they overlap
- Consider the project's own AGENTS.md conventions when evaluating code`,
    defaults: {
      planMode: true,
    },
  },
  {
    id: "fix-code-review-issues",
    name: "Fix Code Review Issues",
    description:
      "Reads the code_review/ folder and systematically fixes identified issues by priority.",
    prompt: `Read all files in the \`code_review/\` folder (README.md, layers.md, functionalities.md, modules.md, files.md) and fix the issues identified in the review.

**Approach:**
1. Start by reading \`code_review/README.md\` to understand the overall findings and top recommendations
2. Read \`code_review/files.md\` for specific file-level issues with line numbers
3. Prioritize fixes by severity: Critical first, then Major, then Minor
4. Skip Suggestion-level items unless they are quick wins

**Rules:**
- Fix the code, not the review — do not modify files in \`code_review/\`
- Ensure each fix doesn't break existing tests — run the test suite after each batch of related fixes
- Follow the coding conventions in AGENTS.md
- If a fix requires a larger refactor, note it in the plan but implement it incrementally
- Track which issues you've fixed in your status updates`,
    defaults: {
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
- Follow the coding conventions in AGENTS.md`,
    defaults: {
      planMode: false,
    },
  },
  {
    id: "continue-planned-tasks",
    name: "Continue Planned Tasks",
    description:
      "Reads the .ralph-planning/ folder and continues executing the next pending task.",
    prompt: `Continue working on the planned tasks.

Read \`.ralph-planning/plan.md\` for the full plan and \`.ralph-planning/status.md\` for current progress. Pick up the next pending task and continue implementation.

Follow the standard workflow from AGENTS.md — update status after each completed task.`,
    defaults: {
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
- \`README.md\` and any other \`*.md\` files (excluding dependency directories, \`code_review/\`, and \`.ralph-planning/\`)
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
- Follow the project's AGENTS.md conventions if present
- Run the project's build command after all changes to verify nothing is broken`,
    defaults: {
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
