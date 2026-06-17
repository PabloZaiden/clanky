/**
 * Hook for fetching and caching tab content (plan, status, diff, review comments,
 * pull-request destination) in TaskDetails.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { FileDiff, FileContentResponse, Task, PullRequestDestinationResponse } from "../../types";
import type { ReviewComment } from "../../types/task";
import { log } from "../../lib/logger";
import { appFetch } from "../../lib/public-path";
import type { TabId } from "./types";

interface UseTaskContentOptions {
  taskId: string;
  task: Task | null;
  activeTab: TabId;
  gitChangeCounter: number;
  getDiff: () => Promise<FileDiff[]>;
  getPlan: () => Promise<FileContentResponse>;
  getStatusFile: () => Promise<FileContentResponse>;
  getPullRequestDestination: () => Promise<PullRequestDestinationResponse>;
  setTabsWithUpdates: React.Dispatch<React.SetStateAction<Set<TabId>>>;
}

export interface UseTaskContentResult {
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

export function useTaskContent({
  taskId,
  task,
  activeTab,
  gitChangeCounter,
  getDiff,
  getPlan,
  getStatusFile,
  getPullRequestDestination,
  setTabsWithUpdates,
}: UseTaskContentOptions): UseTaskContentResult {
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
      const response = await appFetch(`/api/tasks/${taskId}/comments`);
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
  }, [taskId]);

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

    if (activeTab !== "log") {
      loadContent();
    }

    // Fetch review comments separately so loadingComments (not loadingContent) reflects the state
    if (activeTab === "actions" && task?.state.reviewMode) {
      fetchReviewComments();
    }
  }, [activeTab, getPlan, getStatusFile, getDiff, fetchReviewComments, task?.state.reviewMode]);

  // Load plan content when in planning mode to keep it fresh regardless of active tab
  useEffect(() => {
    async function loadPlanForPlanningMode() {
      if (task?.state.status === "planning") {
        try {
          const content = await getPlan();
          setPlanContent(content);
        } catch {
          // Ignore errors — plan might not exist yet
        }
      }
    }
    loadPlanForPlanningMode();
  }, [task?.state.status, getPlan, gitChangeCounter]);

  useEffect(() => {
    const fallbackPlanContent = task?.state.planMode?.planContent?.trim();
    if (
      task?.state.status === "planning"
      && fallbackPlanContent
      && (!planContent?.exists || !planContent.content.trim())
    ) {
      setPlanContent({
        content: fallbackPlanContent,
        exists: true,
      });
    }
  }, [task?.state.status, task?.state.planMode?.planContent, planContent]);

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

  // Refetch comments when task state changes (comment submitted or task completes)
  useEffect(() => {
    if (task?.state.reviewMode && activeTab === "actions") {
      fetchReviewComments();
    }
  }, [task?.state.reviewMode?.reviewCycles, task?.state.status, activeTab, fetchReviewComments]);

  // Load pull-request destination when the task is pushed and addressable
  useEffect(() => {
    const requestId = ++pullRequestDestinationRequestId.current;
    let isCancelled = false;

    async function loadPullRequestDestination() {
      if (task?.state.status !== "pushed" || task.state.reviewMode?.addressable !== true) {
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
    task?.state.status,
    task?.state.reviewMode?.addressable,
    task?.state.reviewMode?.reviewCycles,
    task?.state.git?.workingBranch,
    task?.config.baseBranch,
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
