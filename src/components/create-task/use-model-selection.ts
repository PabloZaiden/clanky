/**
 * useModelSelection — manages main and cheap helper-model selection state for CreateTaskForm.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  getStoredTaskCheapModelPreference,
  getStoredTaskModelPreference,
} from "../../lib/model-selection-preferences";
import {
  isModelEnabled,
  makeModelKey,
  getPreferredModelVariant,
  parseModelKey,
} from "../ModelSelector";
import { createClientLogger } from "../../lib/client-logger";
import type { CheapModelSelection } from "@/shared";
import type { CreateTaskFormProps } from "./types";

const log = createClientLogger("CreateTaskForm");

type InitialTaskData = CreateTaskFormProps["initialTaskData"];

export const SAME_AS_TASK_CHEAP_MODEL_VALUE = "__same_as_task_model__";

function isCheapModelSelectionAvailable(
  models: CreateTaskFormProps["models"],
  selection: CheapModelSelection,
): boolean {
  const availableModels = models ?? [];
  if (selection.mode === "same-as-task") {
    return true;
  }

  const variant = getPreferredModelVariant(
    availableModels,
    selection.model.providerID,
    selection.model.modelID,
    selection.model.variant ?? "",
  );
  if (variant === null) {
    return false;
  }
  return isModelEnabled(
    availableModels,
    makeModelKey(selection.model.providerID, selection.model.modelID, variant),
  );
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

function getPreferredCheapModelValue(
  models: CreateTaskFormProps["models"],
  selection?: CheapModelSelection | null,
): string {
  if (!selection || !isCheapModelSelectionAvailable(models, selection)) {
    return SAME_AS_TASK_CHEAP_MODEL_VALUE;
  }

  return cheapModelSelectionToValue(selection);
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

    if (initialTaskData?.model && models && models.length > 0) {
      const variant = getPreferredModelVariant(
        models,
        initialTaskData.model.providerID,
        initialTaskData.model.modelID,
        initialTaskData.model.variant ?? "",
      );
      if (variant !== null) {
        const modelKey = makeModelKey(
          initialTaskData.model.providerID,
          initialTaskData.model.modelID,
          variant,
        );
        log.debug("Setting model from initialTaskData:", modelKey);
        setSelectedModel(modelKey);
        return;
      }
    }

    const fallbackModel = storedTaskModel ?? lastModel;
    if (fallbackModel && models && models.length > 0) {
      const variant = getPreferredModelVariant(
        models,
        fallbackModel.providerID,
        fallbackModel.modelID,
        fallbackModel.variant ?? "",
      );
      if (variant !== null) {
        const modelKey = makeModelKey(
          fallbackModel.providerID,
          fallbackModel.modelID,
          variant,
        );
        log.debug("Setting model from stored fallback:", modelKey);
        setSelectedModel(modelKey);
        return;
      }
    }

    const firstConnected = models?.find((model) => model.connected);
    if (firstConnected) {
      const variant =
        firstConnected.variants && firstConnected.variants.length > 0
          ? firstConnected.variants[0]
          : "";
      const modelKey = makeModelKey(firstConnected.providerID, firstConnected.modelID, variant);
      log.debug("Setting model to first connected:", modelKey);
      setSelectedModel(modelKey);
    }
  }, [lastModel, models, selectedModel, initialTaskData]);

  const setSelectedCheapModel = useCallback((value: string) => {
    cheapModelTouchedRef.current = true;
    setSelectedCheapModelState(value);
  }, []);

  useEffect(() => {
    const preferredCheapModel = getPreferredCheapModelValue(
      models,
      initialTaskData?.cheapModel
        ?? storedTaskCheapModel
        ?? lastCheapModel,
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
  }, [initialTaskData, lastCheapModel, models, selectedCheapModel]);

  return {
    selectedModel,
    setSelectedModel,
    selectedCheapModel,
    setSelectedCheapModel,
  };
}
