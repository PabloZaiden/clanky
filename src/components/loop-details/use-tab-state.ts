/**
 * Hook for managing tab selection and per-tab update indicators in LoopDetails.
 */

import { useEffect, useRef, useState } from "react";
import type { Loop } from "../../types";
import { isFinalState, canAccept } from "../../utils";
import type { TabId } from "./types";

interface UseTabStateOptions {
  loopId: string;
  loop: Loop | null;
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
  loopId,
  loop,
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

  // Reset initialTabSet when loopId changes so a new planning loop can auto-switch to Plan tab
  useEffect(() => {
    initialTabSet.current = false;
  }, [loopId]);

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
    if (!loop) return;

    const isFinal = isFinalState(loop.state.status);
    const hasAddressable = loop.state.reviewMode?.addressable ?? false;
    const hasAccept = canAccept(loop.state.status) && !!loop.state.git;
    const planReady = loop.state.planMode?.isPlanReady ?? false;
    const currentActionsState = `${isFinal}-${hasAddressable}-${hasAccept}-${loop.state.status}-${planReady}`;

    if (prevActionsState.current !== null && currentActionsState !== prevActionsState.current && activeTab !== "actions") {
      setTabsWithUpdates((prev) => new Set(prev).add("actions"));
    }
    prevActionsState.current = currentActionsState;
  }, [loop?.state.status, loop?.state.reviewMode?.addressable, loop?.state.git, loop?.state.planMode?.isPlanReady, activeTab, loop]);

  // Default to "plan" tab when in planning mode on initial load
  const isCurrentlyPlanning = loop?.state.status === "planning";

  useEffect(() => {
    if (isCurrentlyPlanning && !initialTabSet.current) {
      setActiveTab("plan");
      initialTabSet.current = true;
    }
  }, [isCurrentlyPlanning]);

  return { activeTab, tabsWithUpdates, setTabsWithUpdates, handleTabChange };
}
