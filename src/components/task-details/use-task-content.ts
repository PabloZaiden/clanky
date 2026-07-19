/**
 * Hook for fetching and caching tab content (plan, status, diff, review comments,
 * pull-request destination) in TaskDetails.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Task } from "@/shared";
import type { FileDiff, FileContentResponse, PullRequestDestinationResponse } from "@/contracts";
import type { ReviewComment } from "@/shared/task";
import { log } from "@pablozaiden/webapp/web";
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
  loadingPlanContent: boolean;
  loadingStatusContent: boolean;
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
  const [planContentTaskId, setPlanContentTaskId] = useState<string | null>(null);
  const [statusContentTaskId, setStatusContentTaskId] = useState<string | null>(null);
  const [diffContentTaskId, setDiffContentTaskId] = useState<string | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);
  const [loadingPlanContent, setLoadingPlanContent] = useState(false);
  const [loadingStatusContent, setLoadingStatusContent] = useState(false);
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
  const contentAvailability = useRef({ diff: false, plan: false, status: false });
  contentAvailability.current = {
    diff: diffContentTaskId === taskId,
    plan: planContentTaskId === taskId,
    status: statusContentTaskId === taskId,
  };

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
    let isCancelled = false;

    async function loadContent() {
      if (activeTab !== "plan" && activeTab !== "diff") {
        setLoadingContent(false);
        setLoadingPlanContent(false);
        setLoadingStatusContent(false);
        return;
      }

      const shouldShowPlanLoading = activeTab === "plan" && !contentAvailability.current.plan;
      const shouldShowStatusLoading = activeTab === "plan" && !contentAvailability.current.status;
      const shouldShowDiffLoading = activeTab === "diff" && !contentAvailability.current.diff;

      setLoadingPlanContent(shouldShowPlanLoading);
      setLoadingStatusContent(shouldShowStatusLoading);
      if (shouldShowDiffLoading) {
        setLoadingContent(true);
      }

      try {
        if (activeTab === "plan") {
          // Load both plan and status content together since status is embedded in the plan tab
          const [planResult, statusResult] = await Promise.all([getPlan(), getStatusFile()]);
          if (isCancelled) {
            return;
          }
          setPlanContent(planResult);
          setPlanContentTaskId(taskId);
          setStatusContent(statusResult);
          setStatusContentTaskId(taskId);
        } else if (activeTab === "diff") {
          const content = await getDiff();
          if (isCancelled) {
            return;
          }
          setDiffContent(content);
          setDiffContentTaskId(taskId);
        }
      } finally {
        if (!isCancelled) {
          if (shouldShowPlanLoading) {
            setLoadingPlanContent(false);
          }
          if (shouldShowStatusLoading) {
            setLoadingStatusContent(false);
          }
          if (shouldShowDiffLoading) {
            setLoadingContent(false);
          }
        }
      }
    }

    loadContent();

    return () => {
      isCancelled = true;
    };
  }, [activeTab, getPlan, getStatusFile, getDiff, taskId]);

  // Load plan content when in planning mode to keep it fresh regardless of active tab
  useEffect(() => {
    async function loadPlanForPlanningMode() {
      if (task?.state.status === "planning") {
        try {
          const content = await getPlan();
          setPlanContent(content);
          setPlanContentTaskId(taskId);
        } catch {
          // Ignore errors — plan might not exist yet
        }
      }
    }
    loadPlanForPlanningMode();
  }, [task?.state.status, getPlan, gitChangeCounter, taskId]);

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
      setPlanContentTaskId(taskId);
    }
  }, [taskId, task?.state.status, task?.state.planMode?.planContent, planContent]);

  // Detect changes in diff content by fetching when git events occur
  useEffect(() => {
    async function checkDiffChanges() {
      if (gitChangeCounter > prevGitChangeCounter.current) {
        const newDiff = await getDiff();

        if (newDiff.length > prevDiffFileCount.current && activeTab !== "diff") {
          setTabsWithUpdates((prev) => new Set(prev).add("diff"));
        }

        setDiffContent(newDiff);
        setDiffContentTaskId(taskId);
        prevDiffFileCount.current = newDiff.length;
      }
      prevGitChangeCounter.current = gitChangeCounter;
    }

    checkDiffChanges();
  }, [gitChangeCounter, activeTab, getDiff, setTabsWithUpdates, taskId]);

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
  }, [
    task?.state.reviewMode?.addressable,
    task?.state.reviewMode?.completionAction,
    task?.state.reviewMode?.reviewCycles,
    task?.state.status,
    activeTab,
    fetchReviewComments,
  ]);

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
    planContent: planContentTaskId === taskId ? planContent : null,
    statusContent: statusContentTaskId === taskId ? statusContent : null,
    diffContent: diffContentTaskId === taskId ? diffContent : [],
    reviewComments,
    pullRequestDestination,
    loadingContent,
    loadingPlanContent,
    loadingStatusContent,
    loadingComments,
    loadingPullRequestDestination,
    expandedFiles,
    setExpandedFiles,
    fetchReviewComments,
  };
}
