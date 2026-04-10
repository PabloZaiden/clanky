/**
 * AGENTS.md optimizer for Ralpher workspaces.
 *
 * Provides functions to analyze, preview, and optimize a workspace's AGENTS.md
 * file by injecting the minimal planning conventions that Ralpher depends on.
 *
 * Only structural/workflow conventions are injected (planning files, incremental
 * status tracking). Runtime-specific behavior (completion signals, unattended
 * operation) is NOT included — those are handled by Ralpher's own prompts.
 */

/** Current version of the Ralpher optimization section */
export const RALPHER_OPTIMIZATION_VERSION = 1;

/** Marker used to detect if AGENTS.md has already been optimized */
const MARKER_PATTERN = /<!-- ralpher-optimized-v(\d+) -->/;

/**
 * The Ralpher-specific guidelines section to inject into AGENTS.md.
 * This content is human-friendly and agent-agnostic — it works for both
 * Ralpher loops and direct human-agent workflows.
 */
function getRalpherSection(): string {
  return `<!-- ralpher-optimized-v${RALPHER_OPTIMIZATION_VERSION} -->
## Agentic Workflow — Planning & Progress Tracking

When working on tasks, follow this workflow to ensure clarity, goal alignment, and resilience to context loss:

### Planning

- At the start of any multi-step task, write your goals and plan in \`./.ralph-planning/plan.md\`.
- Track the status of each task in \`./.ralph-planning/status.md\`.
- Make sure that goals are written down in a way that you can properly verify them later.
- Don't say something is done until you have verified that all goals are met.
- **Never start implementation before the plan is confirmed.** Present the plan to the user and wait for explicit approval before writing any code. If the plan needs changes, revise and re-confirm before proceeding.

### Incremental Progress Tracking

- After completing each individual task, **immediately** update \`./.ralph-planning/status.md\` to mark it as completed and note any relevant findings or context.
- Do **not** wait until the end of a session to batch-update progress — update after every task so that progress is preserved even if the session is interrupted or context is lost.

### Pre-Compaction Persistence

- Before ending your response, update \`./.ralph-planning/status.md\` with:
  - The task you are currently working on and its current state
  - Updated status of all tasks in the plan
  - Any new learnings, discoveries, or important context gathered
  - What the next steps should be when work resumes
- This ensures progress is preserved even if the conversation context is compacted or summarized between iterations. Treat the status file as your persistent memory.

### Goal Verification

- Before considering work complete, check \`./.ralph-planning/plan.md\` and \`./.ralph-planning/status.md\` to ensure all tasks are actually marked as completed.
- Follow this general loop:
  1. Write down goals in the plan
  2. Implement the work
  3. Verify all goals are met
  4. Update status with progress
  5. If all goals are met, you are done; otherwise, continue from step 2`;
}

/**
 * Result of analyzing an AGENTS.md file for Ralpher optimization.
 */
export interface OptimizationAnalysis {
  /** Whether the file already contains a Ralpher optimization section */
  isOptimized: boolean;
  /** The version of the existing optimization, or null if not optimized */
  currentVersion: number | null;
  /** Whether an update is available (newer version exists) */
  updateAvailable: boolean;
}

/**
 * Result of a preview operation showing what would change.
 */
export interface OptimizationPreview {
  /** The current AGENTS.md content (empty string if file doesn't exist) */
  currentContent: string;
  /** The proposed optimized content */
  proposedContent: string;
  /** Analysis of the current state */
  analysis: OptimizationAnalysis;
  /** Whether the file currently exists */
  fileExists: boolean;
  /** The Ralpher section that would be added/updated */
  ralpherSection: string;
}

/**
 * Analyze an AGENTS.md file to determine its optimization state.
 */
export function analyzeAgentsMd(content: string | null): OptimizationAnalysis {
  if (content === null || content.trim() === "") {
    return {
      isOptimized: false,
      currentVersion: null,
      updateAvailable: true,
    };
  }

  const match = content.match(MARKER_PATTERN);
  if (!match) {
    return {
      isOptimized: false,
      currentVersion: null,
      updateAvailable: true,
    };
  }

  const currentVersion = parseInt(match[1]!, 10);
  return {
    isOptimized: true,
    currentVersion,
    updateAvailable: currentVersion < RALPHER_OPTIMIZATION_VERSION,
  };
}

/**
 * Generate a preview of what the optimized AGENTS.md would look like.
 */
export function previewOptimization(
  currentContent: string | null,
  fileExists: boolean,
): OptimizationPreview {
  const analysis = analyzeAgentsMd(currentContent);
  const ralpherSection = getRalpherSection();
  const proposedContent = optimizeContent(currentContent, analysis);

  return {
    currentContent: currentContent ?? "",
    proposedContent,
    analysis,
    fileExists,
    ralpherSection,
  };
}

/**
 * Generate optimized AGENTS.md content.
 *
 * - If the file doesn't exist or is empty, creates content with only the Ralpher section.
 * - If the file exists but has no Ralpher section, appends it at the end.
 * - If the file already has a Ralpher section at the current version, returns as-is.
 * - If the file has an older version, replaces the old section with the new one.
 */
export function optimizeContent(
  currentContent: string | null,
  analysis?: OptimizationAnalysis,
): string {
  const effectiveAnalysis = analysis ?? analyzeAgentsMd(currentContent);
  const ralpherSection = getRalpherSection();

  // No existing content — create fresh file
  if (currentContent === null || currentContent.trim() === "") {
    return ralpherSection + "\n";
  }

  // Already optimized at current version — no changes needed
  if (effectiveAnalysis.isOptimized && !effectiveAnalysis.updateAvailable) {
    return currentContent;
  }

  // Has an older version — replace the old section
  if (effectiveAnalysis.isOptimized && effectiveAnalysis.updateAvailable) {
    return replaceRalpherSection(currentContent, ralpherSection);
  }

  // Not optimized — append the section
  const separator = currentContent.endsWith("\n") ? "\n" : "\n\n";
  return currentContent + separator + ralpherSection + "\n";
}

/**
 * Replace an existing Ralpher section with a new one.
 * Finds the marker and replaces everything from the marker to the next
 * peer-level heading (## but not ###) or horizontal rule (---), or to the
 * end of the file.
 */
function replaceRalpherSection(content: string, newSection: string): string {
  const markerIndex = content.search(MARKER_PATTERN);
  if (markerIndex === -1) {
    // No marker found — shouldn't happen if called correctly, but append
    const separator = content.endsWith("\n") ? "\n" : "\n\n";
    return content + separator + newSection + "\n";
  }

  // Find the end of the Ralpher section.
  // Phase 1: Skip lines until we find the first ## heading after the marker.
  // Phase 2: After finding the section's own heading, look for the next peer
  //          ## heading or --- horizontal rule that signals the end of our section.
  const afterMarker = content.substring(markerIndex);
  const lines = afterMarker.split("\n");

  let endIndex = afterMarker.length; // default: rest of file
  let lineOffset = 0;
  let foundSectionHeading = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const isTopLevelHeading = /^## [^#]/.test(line);
    const isHorizontalRule = /^---\s*$/.test(line);

    if (!foundSectionHeading) {
      // Phase 1: skip everything until we find the section's own ## heading
      lineOffset += line.length + 1;
      if (isTopLevelHeading) {
        foundSectionHeading = true;
      }
      continue;
    }

    // Phase 2: look for the next peer ## heading or --- horizontal rule
    if (isTopLevelHeading || isHorizontalRule) {
      endIndex = lineOffset;
      break;
    }
    lineOffset += line.length + 1;
  }

  const before = content.substring(0, markerIndex).trimEnd();
  const after = content.substring(markerIndex + endIndex).trimStart();

  if (after.length > 0) {
    return before + "\n\n" + newSection + "\n\n" + after;
  }
  return before + "\n\n" + newSection + "\n";
}

/**
 * Get the current Ralpher section content (for display purposes).
 */
export function getRalpherSectionContent(): string {
  return getRalpherSection();
}
