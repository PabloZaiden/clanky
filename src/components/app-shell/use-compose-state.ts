import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from "react";
import type { CreateLoopRequest } from "../../types";
import type { CreateLoopResult } from "../../hooks/useLoops";
import type { UseDashboardDataResult } from "../../hooks/useDashboardData";
import type { ToastContextValue } from "../../hooks/useToast";
import type { ShellRoute } from "./shell-types";
import { getHashForShellRoute } from "./shell-navigation";
import type { CreateLoopFormActionState, CreateLoopFormSubmitRequest } from "../CreateLoopForm";

type LoopComposeRoute = Extract<ShellRoute, { view: "compose"; kind: "loop" }>;

function isLoopComposeRoute(
  route: ShellRoute,
): route is LoopComposeRoute {
  return route.view === "compose" && route.kind === "loop";
}

export interface UseComposeStateResult {
  composeActionState: CreateLoopFormActionState | null;
  setComposeActionState: Dispatch<SetStateAction<CreateLoopFormActionState | null>>;
  handleLoopSubmit: (request: CreateLoopFormSubmitRequest) => Promise<boolean>;
}

interface UseComposeStateOptions {
  route: ShellRoute;
  createLoop: (req: CreateLoopRequest) => Promise<CreateLoopResult>;
  refreshLoops: () => Promise<void>;
  navigateWithinShell: (route: ShellRoute) => void;
  dashboardData: UseDashboardDataResult;
  toast: ToastContextValue;
}

export function useComposeState({
  route,
  createLoop,
  refreshLoops,
  navigateWithinShell,
  dashboardData,
  toast,
}: UseComposeStateOptions): UseComposeStateResult {
  const [composeActionState, setComposeActionState] = useState<CreateLoopFormActionState | null>(null);
  const latestRouteRef = useRef(route);
  const nextSubmissionIdRef = useRef(0);
  const activeAutoOpenSubmissionRef = useRef<number | null>(null);
  const activeSubmissionHashRef = useRef<string | null>(null);

  function clearPendingAutoOpen(submissionId?: number): void {
    if (submissionId !== undefined && activeAutoOpenSubmissionRef.current !== submissionId) {
      return;
    }

    activeAutoOpenSubmissionRef.current = null;
    activeSubmissionHashRef.current = null;
  }

  useEffect(() => {
    latestRouteRef.current = route;

    if (!isLoopComposeRoute(route)) {
      clearPendingAutoOpen();
      return;
    }

    const currentComposeHash = `#${getHashForShellRoute(route)}`;
    if (activeSubmissionHashRef.current && activeSubmissionHashRef.current !== currentComposeHash) {
      clearPendingAutoOpen();
    }
  }, [route]);

  useEffect(() => {
    if (route.view !== "compose") {
      dashboardData.resetCreateModalState();
      return;
    }
    if (route.kind !== "loop") {
      dashboardData.resetCreateModalState();
    }
  }, [dashboardData.resetCreateModalState, route]);

  useEffect(() => {
    if (route.view !== "compose") {
      setComposeActionState(null);
      return;
    }
    if (route.kind !== "loop") {
      setComposeActionState(null);
    }
  }, [route.view, route.view === "compose" ? route.kind : undefined]);

  async function handleLoopSubmit(request: CreateLoopFormSubmitRequest): Promise<boolean> {
    const submissionId = nextSubmissionIdRef.current + 1;
    nextSubmissionIdRef.current = submissionId;
    activeAutoOpenSubmissionRef.current = submissionId;
    activeSubmissionHashRef.current = `#${getHashForShellRoute(latestRouteRef.current)}`;

    const result = await createLoop(request as CreateLoopRequest);

    if (result.startError) {
      clearPendingAutoOpen(submissionId);
      toast.error("Uncommitted changes blocked the new run. Resolve them and try again.");
      return false;
    }

    if (!result.loop) {
      clearPendingAutoOpen(submissionId);
      toast.error("Failed to create loop");
      return false;
    }

    await refreshLoops();
    dashboardData.setLastModel(request.model);
    dashboardData.setLastCheapModel(request.cheapModel ?? null);

    const submitHash = activeSubmissionHashRef.current;
    const shouldAutoOpen =
      activeAutoOpenSubmissionRef.current === submissionId &&
      submitHash !== null &&
      window.location.hash === submitHash;

    clearPendingAutoOpen(submissionId);

    if (shouldAutoOpen) {
      navigateWithinShell({ view: "loop", loopId: result.loop.config.id });
    }

    return true;
  }

  return {
    composeActionState,
    setComposeActionState,
    handleLoopSubmit,
  };
}
