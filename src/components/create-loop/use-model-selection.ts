/**
 * useModelSelection — manages main and cheap helper-model selection state for CreateLoopForm.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  getStoredLoopCheapModelPreference,
  getStoredLoopModelPreference,
} from "../../lib/model-selection-preferences";
import {
  isModelEnabled,
  makeModelKey,
  getPreferredModelVariant,
  parseModelKey,
} from "../ModelSelector";
import { createLogger } from "../../lib/logger";
import type { CheapModelSelection } from "../../types";
import type { CreateLoopFormProps } from "./types";

const log = createLogger("CreateLoopForm");

type InitialLoopData = CreateLoopFormProps["initialLoopData"];

export const SAME_AS_LOOP_CHEAP_MODEL_VALUE = "__same_as_loop_model__";

function isCheapModelSelectionAvailable(
  models: CreateLoopFormProps["models"],
  selection: CheapModelSelection,
): boolean {
  const availableModels = models ?? [];
  if (selection.mode === "same-as-loop") {
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
  if (!selection || selection.mode === "same-as-loop") {
    return SAME_AS_LOOP_CHEAP_MODEL_VALUE;
  }

  return makeModelKey(
    selection.model.providerID,
    selection.model.modelID,
    selection.model.variant ?? "",
  );
}

export function cheapModelValueToSelection(value: string): CheapModelSelection {
  if (!value || value === SAME_AS_LOOP_CHEAP_MODEL_VALUE) {
    return { mode: "same-as-loop" };
  }

  const parsed = parseModelKey(value);
  if (!parsed) {
    return { mode: "same-as-loop" };
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
  models: CreateLoopFormProps["models"],
  value: string,
): boolean {
  return isCheapModelSelectionAvailable(models, cheapModelValueToSelection(value));
}

function getPreferredCheapModelValue(
  models: CreateLoopFormProps["models"],
  selection?: CheapModelSelection | null,
): string {
  if (!selection || !isCheapModelSelectionAvailable(models, selection)) {
    return SAME_AS_LOOP_CHEAP_MODEL_VALUE;
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
  initialLoopData,
}: {
  models: CreateLoopFormProps["models"];
  lastModel: CreateLoopFormProps["lastModel"];
  lastCheapModel: CreateLoopFormProps["lastCheapModel"];
  initialLoopData: InitialLoopData;
}): UseModelSelectionReturn {
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [selectedCheapModel, setSelectedCheapModelState] = useState<string>(
    SAME_AS_LOOP_CHEAP_MODEL_VALUE,
  );
  const cheapModelTouchedRef = useRef(false);
  const storedLoopModel = useMemo(() => getStoredLoopModelPreference(), []);
  const storedLoopCheapModel = useMemo(() => getStoredLoopCheapModelPreference(), []);

  useEffect(() => {
    log.debug("useEffect 2 - model selection", {
      selectedModel,
      lastModel,
      modelsCount: models?.length ?? 0,
      initialLoopDataModel: initialLoopData?.model,
    });
    if (selectedModel) return;

    if (initialLoopData?.model && models && models.length > 0) {
      const variant = getPreferredModelVariant(
        models,
        initialLoopData.model.providerID,
        initialLoopData.model.modelID,
        initialLoopData.model.variant ?? "",
      );
      if (variant !== null) {
        const modelKey = makeModelKey(
          initialLoopData.model.providerID,
          initialLoopData.model.modelID,
          variant,
        );
        log.debug("Setting model from initialLoopData:", modelKey);
        setSelectedModel(modelKey);
        return;
      }
    }

    const fallbackModel = storedLoopModel ?? lastModel;
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
  }, [lastModel, models, selectedModel, initialLoopData]);

  const setSelectedCheapModel = useCallback((value: string) => {
    cheapModelTouchedRef.current = true;
    setSelectedCheapModelState(value);
  }, []);

  useEffect(() => {
    const preferredCheapModel = getPreferredCheapModelValue(
      models,
      initialLoopData?.cheapModel
        ?? storedLoopCheapModel
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
  }, [initialLoopData, lastCheapModel, models, selectedCheapModel]);

  return {
    selectedModel,
    setSelectedModel,
    selectedCheapModel,
    setSelectedCheapModel,
  };
}
