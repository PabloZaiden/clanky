import { type Dispatch, type SetStateAction, useEffect, useState } from "react";
import type { CreateLoopRequest } from "../../types";
import type { CreateLoopResult } from "../../hooks/useLoops";
import type { UseDashboardDataResult } from "../../hooks/useDashboardData";
import type { ToastContextValue } from "../../hooks/useToast";
import type { ShellRoute } from "./shell-types";
import type { CreateLoopFormActionState, CreateLoopFormSubmitRequest } from "../CreateLoopForm";

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
    const createLoopPromise = createLoop(request as CreateLoopRequest);

    if (!request.draft) {
      navigateWithinShell({ view: "workspace", workspaceId: request.workspaceId });
    }

    const result = await createLoopPromise;

    if (result.startError) {
      toast.error("Uncommitted changes blocked the new run. Resolve them and try again.");
      return false;
    }

    if (!result.loop) {
      toast.error("Failed to create loop");
      return false;
    }

    await refreshLoops();
    dashboardData.setLastModel(request.model);
    dashboardData.setLastCheapModel(request.cheapModel ?? null);

    return true;
  }

  return {
    composeActionState,
    setComposeActionState,
    handleLoopSubmit,
  };
}
