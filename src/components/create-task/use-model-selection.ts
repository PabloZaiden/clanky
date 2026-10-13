/**
 * useModelSelection — manages main and cheap helper-model selection state for CreateTaskForm.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  getStoredTaskCheapModelPreference,
  getStoredTaskModelPreference,
} from "../../lib/model-selection-preferences";
import {
  makeModelKey,
  parseModelKey,
} from "../ModelSelector";
import { createLogger } from "@pablozaiden/webapp/web";
import type { CheapModelSelection } from "@/shared";
import {
  resolveTaskCreationCheapModel,
  resolveTaskCreationModel,
} from "@/shared/task-creation";
import type { CreateTaskFormProps } from "./types";

const log = createLogger("CreateTaskForm");

type InitialTaskData = CreateTaskFormProps["initialTaskData"];

export const SAME_AS_TASK_CHEAP_MODEL_VALUE = "__same_as_task_model__";

function isCheapModelSelectionAvailable(
  models: CreateTaskFormProps["models"],
  selection: CheapModelSelection,
): boolean {
  if (selection.mode === "same-as-task") {
    return true;
  }
  return resolveTaskCreationCheapModel({
    models: models ?? [],
    initialCheapModel: selection,
  }).mode === "custom";
}

export function cheapModelSelectionToValue(selection?: CheapModelSelection | null): string {
  if (!selection || selection.mode === "same-as-task") {
    return SAME_AS_TASK_CHEAP_MODEL_VALUE;
  }

  return makeModelKey(
    selection.model.providerID,
    selection.model.modelID,
    selection.model.variant ?? "",
  );
}

export function cheapModelValueToSelection(value: string): CheapModelSelection {
  if (!value || value === SAME_AS_TASK_CHEAP_MODEL_VALUE) {
    return { mode: "same-as-task" };
  }

  const parsed = parseModelKey(value);
  if (!parsed) {
    return { mode: "same-as-task" };
  }

  return {
    mode: "custom",
    model: {
      providerID: parsed.providerID,
      modelID: parsed.modelID,
      variant: parsed.variant,
    },
  };
}

export function isCheapModelValueAvailable(
  models: CreateTaskFormProps["models"],
  value: string,
): boolean {
  return isCheapModelSelectionAvailable(models, cheapModelValueToSelection(value));
}

export interface UseModelSelectionReturn {
  selectedModel: string;
  setSelectedModel: (v: string) => void;
  selectedCheapModel: string;
  setSelectedCheapModel: (v: string) => void;
}

export function useModelSelection({
  models,
  lastModel,
  lastCheapModel,
  initialTaskData,
}: {
  models: CreateTaskFormProps["models"];
  lastModel: CreateTaskFormProps["lastModel"];
  lastCheapModel: CreateTaskFormProps["lastCheapModel"];
  initialTaskData: InitialTaskData;
}): UseModelSelectionReturn {
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [selectedCheapModel, setSelectedCheapModelState] = useState<string>(
    SAME_AS_TASK_CHEAP_MODEL_VALUE,
  );
  const cheapModelTouchedRef = useRef(false);
  const storedTaskModel = useMemo(() => getStoredTaskModelPreference(), []);
  const storedTaskCheapModel = useMemo(() => getStoredTaskCheapModelPreference(), []);

  useEffect(() => {
    log.debug("useEffect 2 - model selection", {
      selectedModel,
      lastModel,
      modelsCount: models?.length ?? 0,
      initialTaskDataModel: initialTaskData?.model,
    });
    if (selectedModel) return;

    const model = resolveTaskCreationModel({
      models: models ?? [],
      initialModel: initialTaskData?.model,
      storedModel: storedTaskModel,
      lastModel,
    });
    if (model) {
      const modelKey = makeModelKey(model.providerID, model.modelID, model.variant);
      log.debug("Setting preferred task model:", modelKey);
      setSelectedModel(modelKey);
    }
  }, [lastModel, models, selectedModel, initialTaskData, storedTaskModel]);

  const setSelectedCheapModel = useCallback((value: string) => {
    cheapModelTouchedRef.current = true;
    setSelectedCheapModelState(value);
  }, []);

  useEffect(() => {
    const preferredCheapModel = cheapModelSelectionToValue(
      resolveTaskCreationCheapModel({
        models: models ?? [],
        initialCheapModel: initialTaskData?.cheapModel,
        storedCheapModel: storedTaskCheapModel,
        lastCheapModel,
      }),
    );

    if (!cheapModelTouchedRef.current) {
      if (selectedCheapModel !== preferredCheapModel) {
        setSelectedCheapModelState(preferredCheapModel);
      }
      return;
    }

    if (!isCheapModelValueAvailable(models, selectedCheapModel)) {
      cheapModelTouchedRef.current = false;
      setSelectedCheapModelState(preferredCheapModel);
    }
  }, [initialTaskData, lastCheapModel, models, selectedCheapModel, storedTaskCheapModel]);

  return {
    selectedModel,
    setSelectedModel,
    selectedCheapModel,
    setSelectedCheapModel,
  };
}
