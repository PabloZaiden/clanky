import { createHash } from "node:crypto";
import { sanitizeBranchName } from "../utils";

const SHORT_PROMPT_HASH_LENGTH = 7;
const MAX_PREFIX_SEGMENT_LENGTH = 40;

function buildShortPromptHash(prompt: string): string {
  return createHash("sha1")
    .update(prompt)
    .digest("hex")
    .slice(0, SHORT_PROMPT_HASH_LENGTH);
}

function sanitizeBranchPrefixSegment(segment: string): string {
  return segment
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, MAX_PREFIX_SEGMENT_LENGTH)
    .replace(/^-|-$/g, "");
}

export function normalizeBranchPrefix(prefix: string): string {
  const segments = prefix
    .trim()
    .split("/")
    .map((segment) => sanitizeBranchPrefixSegment(segment))
    .filter((segment) => segment.length > 0);

  if (segments.length === 0) {
    return "";
  }

  return `${segments.join("/")}/`;
}

export function buildTaskBranchName(title: string, prompt: string): string {
  const safeTitle = sanitizeBranchName(title);
  const shortPromptHash = buildShortPromptHash(prompt);
  return `${safeTitle}-${shortPromptHash}`;
}

export function buildReviewBranchName(baseBranchName: string, reviewCycle: number): string {
  return `${baseBranchName}-review-${reviewCycle}`;
}
