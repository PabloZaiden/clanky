/**
 * Hook for managing tab selection and per-tab update indicators in TaskDetails.
 */

import { useEffect, useRef, useState } from "react";
import type { Task } from "@/shared";
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
