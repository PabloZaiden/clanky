import { type Dispatch, type SetStateAction, useEffect, useState } from "react";
import type { CreateLoopRequest } from "../../types";
import type { CreateLoopResult } from "../../hooks/useLoops";
import type { UseDashboardDataResult } from "../../hooks/useDashboardData";
import type { ToastContextValue } from "../../hooks/useToast";
import {
  saveStoredLoopCheapModelPreference,
  saveStoredLoopModelPreference,
} from "../../lib/model-selection-preferences";
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

  async function finalizeLoopCreation(request: CreateLoopFormSubmitRequest) {
    if (!request.model) {
      toast.error("Please select a model before starting a loop.");
      return null;
    }

    const createRequest: CreateLoopRequest = {
      ...request,
      model: request.model,
    };
    const result = await createLoop(createRequest);

    if (result.startError) {
      toast.error("Uncommitted changes blocked the new run. Resolve them and try again.");
      return null;
    }

    if (!result.loop) {
      toast.error("Failed to create loop");
      return null;
    }

    await refreshLoops();
    dashboardData.setLastModel(request.model);
    dashboardData.setLastCheapModel(request.cheapModel ?? null);
    saveStoredLoopModelPreference(request.model);
    saveStoredLoopCheapModelPreference(request.cheapModel);

    return result.loop;
  }

  async function handleLoopSubmit(request: CreateLoopFormSubmitRequest): Promise<boolean> {
    if (!request.draft) {
      void finalizeLoopCreation(request);
      navigateWithinShell({ view: "workspace", workspaceId: request.workspaceId });
      return true;
    }

    const loop = await finalizeLoopCreation(request);
    if (!loop) {
      return false;
    }

    navigateWithinShell({ view: "loop", loopId: loop.config.id });
    return true;
  }

  return {
    composeActionState,
    setComposeActionState,
    handleLoopSubmit,
  };
}
