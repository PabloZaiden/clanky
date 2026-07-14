/**
 * Hook for managing tab selection and per-tab update indicators in TaskDetails.
 */

import { useEffect, useRef, useState } from "react";
import type { Task } from "@/shared";
import { isFinalState, canAccept } from "../../utils";
import type { TabId } from "./types";

interface UseTabStateOptions {
  taskId: string;
  task: Task | null;
  messagesCount: number;
  toolCallsCount: number;
  logsCount: number;
}

interface UseTabStateResult {
  activeTab: TabId;
  tabsWithUpdates: Set<TabId>;
  setTabsWithUpdates: React.Dispatch<React.SetStateAction<Set<TabId>>>;
  handleTabChange: (tabId: TabId) => void;
}

export function useTabState({
  taskId,
  task,
  messagesCount,
  toolCallsCount,
  logsCount,
}: UseTabStateOptions): UseTabStateResult {
  const [activeTab, setActiveTab] = useState<TabId>("log");
  const [tabsWithUpdates, setTabsWithUpdates] = useState<Set<TabId>>(new Set());

  const prevMessagesCount = useRef(0);
  const prevToolCallsCount = useRef(0);
  const prevLogsCount = useRef(0);
  const prevActionsState = useRef<string | null>(null);
  const initialTabSet = useRef(false);

  function handleTabChange(tabId: TabId) {
    setActiveTab(tabId);
    setTabsWithUpdates((prev) => {
      const next = new Set(prev);
      next.delete(tabId);
      return next;
    });
  }

  // Reset initialTabSet when taskId changes so a new planning task can auto-switch to Plan tab
  useEffect(() => {
    initialTabSet.current = false;
  }, [taskId]);

  // Detect changes in log content (messages, toolCalls, logs)
  useEffect(() => {
    const totalLogItems = messagesCount + toolCallsCount + logsCount;
    const prevTotal = prevMessagesCount.current + prevToolCallsCount.current + prevLogsCount.current;

    if (totalLogItems > prevTotal && activeTab !== "log") {
      setTabsWithUpdates((prev) => new Set(prev).add("log"));
    }

    prevMessagesCount.current = messagesCount;
    prevToolCallsCount.current = toolCallsCount;
    prevLogsCount.current = logsCount;
  }, [messagesCount, toolCallsCount, logsCount, activeTab]);

  // Detect changes in available actions
  useEffect(() => {
    if (!task) return;

    const isFinal = isFinalState(task.state.status);
    const hasAddressable = task.state.reviewMode?.addressable ?? false;
    const hasAccept = canAccept(task.state.status) && !!task.state.git;
    const planReady = task.state.planMode?.isPlanReady ?? false;
    const currentActionsState = `${isFinal}-${hasAddressable}-${hasAccept}-${task.state.status}-${planReady}`;

    if (prevActionsState.current !== null && currentActionsState !== prevActionsState.current && activeTab !== "actions") {
      setTabsWithUpdates((prev) => new Set(prev).add("actions"));
    }
    prevActionsState.current = currentActionsState;
  }, [task?.state.status, task?.state.reviewMode?.addressable, task?.state.git, task?.state.planMode?.isPlanReady, activeTab, task]);

  // Default to "plan" tab when in planning mode on initial load
  const isCurrentlyPlanning = task?.state.status === "planning";

  useEffect(() => {
    if (isCurrentlyPlanning && !initialTabSet.current) {
      setActiveTab("plan");
      initialTabSet.current = true;
    }
  }, [isCurrentlyPlanning]);

  return { activeTab, tabsWithUpdates, setTabsWithUpdates, handleTabChange };
}
