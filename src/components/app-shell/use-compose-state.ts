import { type Dispatch, type SetStateAction, useEffect, useState } from "react";
import type { WebAppRoute } from "@pablozaiden/webapp/web";
import type { CreateTaskRequest } from "@/contracts";
import type { CreateTaskResult } from "../../hooks/useTasks";
import type { UseDashboardDataResult } from "../../hooks/useDashboardData";
import type { ToastContextValue } from "../../hooks/useToast";
import {
  saveStoredTaskCheapModelPreference,
  saveStoredTaskModelPreference,
} from "../../lib/model-selection-preferences";
import { getRouteString } from "./route-fields";
import type { CreateTaskFormSubmitRequest } from "@/lib/task-request";
import type { CreateTaskFormActionState } from "../CreateTaskForm";

export interface UseComposeStateResult {
  composeActionState: CreateTaskFormActionState | null;
  setComposeActionState: Dispatch<SetStateAction<CreateTaskFormActionState | null>>;
  handleTaskSubmit: (request: CreateTaskFormSubmitRequest) => Promise<boolean>;
}

interface UseComposeStateOptions {
  route: WebAppRoute;
  createTask: (req: CreateTaskRequest) => Promise<CreateTaskResult>;
  refreshTasks: () => Promise<void>;
  navigateWithinShell: (route: WebAppRoute) => void;
  dashboardData: UseDashboardDataResult;
  toast: ToastContextValue;
}

export function useComposeState({
  route,
  createTask,
  refreshTasks,
  navigateWithinShell,
  dashboardData,
  toast,
}: UseComposeStateOptions): UseComposeStateResult {
  const [composeActionState, setComposeActionState] = useState<CreateTaskFormActionState | null>(null);

  useEffect(() => {
    if (route.view !== "compose") {
      dashboardData.resetCreateModalState();
      return;
    }
    if (getRouteString(route, "kind") !== "task") {
      dashboardData.resetCreateModalState();
    }
  }, [dashboardData.resetCreateModalState, route]);

  useEffect(() => {
    if (route.view !== "compose") {
      setComposeActionState(null);
      return;
    }
    if (getRouteString(route, "kind") !== "task") {
      setComposeActionState(null);
    }
  }, [route.view, route.view === "compose" ? getRouteString(route, "kind") : undefined]);

  async function finalizeTaskCreation(request: CreateTaskFormSubmitRequest) {
    if (!request.model) {
      toast.error("Please select a model before starting a task.");
      return null;
    }

    const createRequest: CreateTaskRequest = {
      ...request,
      model: request.model,
    };
    const result = await createTask(createRequest);

    if (result.startError) {
      toast.error("Uncommitted changes blocked the new run. Resolve them and try again.");
      return null;
    }

    if (!result.task) {
      toast.error("Failed to create task");
      return null;
    }

    await refreshTasks();
    dashboardData.setLastModel(request.model);
    dashboardData.setLastCheapModel(request.cheapModel ?? null);
    saveStoredTaskModelPreference(request.model);
    saveStoredTaskCheapModelPreference(request.cheapModel);

    return result.task;
  }

  async function handleTaskSubmit(request: CreateTaskFormSubmitRequest): Promise<boolean> {
    if (!request.draft) {
      void finalizeTaskCreation(request);
      navigateWithinShell({ view: "workspace", workspaceId: request.workspaceId });
      return true;
    }

    const task = await finalizeTaskCreation(request);
    if (!task) {
      return false;
    }

    navigateWithinShell({ view: "task", taskId: task.config.id });
    return true;
  }

  return {
    composeActionState,
    setComposeActionState,
    handleTaskSubmit,
  };
}
