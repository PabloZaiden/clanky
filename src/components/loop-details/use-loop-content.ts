/**
 * Hook for fetching and caching tab content (plan, status, diff, review comments,
 * pull-request destination) in LoopDetails.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { FileDiff, FileContentResponse, Loop, PullRequestDestinationResponse } from "../../types";
import type { ReviewComment } from "../../types/loop";
import { log } from "../../lib/logger";
import { appFetch } from "../../lib/public-path";
import type { TabId } from "./types";

interface UseLoopContentOptions {
  loopId: string;
  loop: Loop | null;
  activeTab: TabId;
  gitChangeCounter: number;
  getDiff: () => Promise<FileDiff[]>;
  getPlan: () => Promise<FileContentResponse>;
  getStatusFile: () => Promise<FileContentResponse>;
  getPullRequestDestination: () => Promise<PullRequestDestinationResponse>;
  setTabsWithUpdates: React.Dispatch<React.SetStateAction<Set<TabId>>>;
}

export interface UseLoopContentResult {
  planContent: FileContentResponse | null;
  statusContent: FileContentResponse | null;
  diffContent: FileDiff[];
  reviewComments: ReviewComment[];
  pullRequestDestination: PullRequestDestinationResponse | null;
  loadingContent: boolean;
  loadingComments: boolean;
  loadingPullRequestDestination: boolean;
  expandedFiles: Set<string>;
  setExpandedFiles: React.Dispatch<React.SetStateAction<Set<string>>>;
  fetchReviewComments: () => Promise<void>;
}

export function useLoopContent({
  loopId,
  loop,
  activeTab,
  gitChangeCounter,
  getDiff,
  getPlan,
  getStatusFile,
  getPullRequestDestination,
  setTabsWithUpdates,
}: UseLoopContentOptions): UseLoopContentResult {
  const [planContent, setPlanContent] = useState<FileContentResponse | null>(null);
  const [statusContent, setStatusContent] = useState<FileContentResponse | null>(null);
  const [diffContent, setDiffContent] = useState<FileDiff[]>([]);
  const [loadingContent, setLoadingContent] = useState(false);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const [reviewComments, setReviewComments] = useState<ReviewComment[]>([]);
  const [loadingComments, setLoadingComments] = useState(false);
  const [pullRequestDestination, setPullRequestDestination] = useState<PullRequestDestinationResponse | null>(null);
  const [loadingPullRequestDestination, setLoadingPullRequestDestination] = useState(false);

  const prevPlanContent = useRef<string | null>(null);
  const prevStatusContent = useRef<string | null>(null);
  const prevGitChangeCounter = useRef(0);
  const prevDiffFileCount = useRef(0);
  const pullRequestDestinationRequestId = useRef(0);

  const fetchReviewComments = useCallback(async () => {
    setLoadingComments(true);
    try {
      const response = await appFetch(`/api/loops/${loopId}/comments`);
      if (response.ok) {
        const data = await response.json();
        if (data.success && data.comments) {
          setReviewComments(data.comments);
        }
      }
    } catch (error) {
      log.error("Failed to fetch review comments:", String(error));
    } finally {
      setLoadingComments(false);
    }
  }, [loopId]);

  // Load content when tab changes
  useEffect(() => {
    async function loadContent() {
      setLoadingContent(true);
      try {
        if (activeTab === "plan") {
          // Load both plan and status content together since status is embedded in the plan tab
          const [planResult, statusResult] = await Promise.all([getPlan(), getStatusFile()]);
          setPlanContent(planResult);
          setStatusContent(statusResult);
        } else if (activeTab === "diff") {
          const content = await getDiff();
          setDiffContent(content);
        } else {
          // No file content to load for other tabs
          setLoadingContent(false);
          return;
        }
      } finally {
        setLoadingContent(false);
      }
    }

    if (activeTab !== "log" && activeTab !== "prompt") {
      loadContent();
    }

    // Fetch review comments separately so loadingComments (not loadingContent) reflects the state
    if (activeTab === "actions" && loop?.state.reviewMode) {
      fetchReviewComments();
    }
  }, [activeTab, getPlan, getStatusFile, getDiff, fetchReviewComments, loop?.state.reviewMode]);

  // Load plan content when in planning mode to keep it fresh regardless of active tab
  useEffect(() => {
    async function loadPlanForPlanningMode() {
      if (loop?.state.status === "planning") {
        try {
          const content = await getPlan();
          setPlanContent(content);
        } catch {
          // Ignore errors — plan might not exist yet
        }
      }
    }
    loadPlanForPlanningMode();
  }, [loop?.state.status, getPlan, gitChangeCounter]);

  useEffect(() => {
    const fallbackPlanContent = loop?.state.planMode?.planContent?.trim();
    if (
      loop?.state.status === "planning"
      && fallbackPlanContent
      && (!planContent?.exists || !planContent.content.trim())
    ) {
      setPlanContent({
        content: fallbackPlanContent,
        exists: true,
      });
    }
  }, [loop?.state.status, loop?.state.planMode?.planContent, planContent]);

  // Detect changes in diff content by fetching when git events occur
  useEffect(() => {
    async function checkDiffChanges() {
      if (gitChangeCounter > prevGitChangeCounter.current) {
        const newDiff = await getDiff();

        if (newDiff.length > prevDiffFileCount.current && activeTab !== "diff") {
          setTabsWithUpdates((prev) => new Set(prev).add("diff"));
        }

        setDiffContent(newDiff);
        prevDiffFileCount.current = newDiff.length;
      }
      prevGitChangeCounter.current = gitChangeCounter;
    }

    checkDiffChanges();
  }, [gitChangeCounter, activeTab, getDiff, setTabsWithUpdates]);

  // Detect changes in plan content
  useEffect(() => {
    const currentContent = planContent?.content ?? null;
    if (currentContent !== null && currentContent !== prevPlanContent.current && activeTab !== "plan") {
      setTabsWithUpdates((prev) => new Set(prev).add("plan"));
    }
    prevPlanContent.current = currentContent;
  }, [planContent?.content, activeTab, setTabsWithUpdates]);

  // Detect changes in status content — mark "plan" tab since status is now embedded there
  useEffect(() => {
    const currentContent = statusContent?.content ?? null;
    if (currentContent !== null && currentContent !== prevStatusContent.current && activeTab !== "plan") {
      setTabsWithUpdates((prev) => new Set(prev).add("plan"));
    }
    prevStatusContent.current = currentContent;
  }, [statusContent?.content, activeTab, setTabsWithUpdates]);

  // Refetch comments when loop state changes (comment submitted or loop completes)
  useEffect(() => {
    if (loop?.state.reviewMode && activeTab === "actions") {
      fetchReviewComments();
    }
  }, [loop?.state.reviewMode?.reviewCycles, loop?.state.status, activeTab, fetchReviewComments]);

  // Load pull-request destination when the loop is pushed and addressable
  useEffect(() => {
    const requestId = ++pullRequestDestinationRequestId.current;
    let isCancelled = false;

    async function loadPullRequestDestination() {
      if (loop?.state.status !== "pushed" || loop.state.reviewMode?.addressable !== true) {
        if (!isCancelled && requestId === pullRequestDestinationRequestId.current) {
          setPullRequestDestination(null);
          setLoadingPullRequestDestination(false);
        }
        return;
      }

      setLoadingPullRequestDestination(true);
      try {
        const destination = await getPullRequestDestination();
        if (!isCancelled && requestId === pullRequestDestinationRequestId.current) {
          setPullRequestDestination(destination);
        }
      } finally {
        if (!isCancelled && requestId === pullRequestDestinationRequestId.current) {
          setLoadingPullRequestDestination(false);
        }
      }
    }

    loadPullRequestDestination();

    return () => {
      isCancelled = true;
    };
  }, [
    loop?.state.status,
    loop?.state.reviewMode?.addressable,
    loop?.state.reviewMode?.reviewCycles,
    loop?.state.git?.workingBranch,
    loop?.config.baseBranch,
    getPullRequestDestination,
  ]);

  return {
    planContent,
    statusContent,
    diffContent,
    reviewComments,
    pullRequestDestination,
    loadingContent,
    loadingComments,
    loadingPullRequestDestination,
    expandedFiles,
    setExpandedFiles,
    fetchReviewComments,
  };
}
