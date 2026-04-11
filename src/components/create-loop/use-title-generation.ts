/**
 * useTitleGeneration — manages auto-generated loop title state.
 */

import { useState, useCallback } from "react";
import { createLogger } from "../../lib/logger";
import { useToast } from "../../hooks";
import { generateLoopTitleApi } from "../../hooks/loopActions";
import { parseModelKey } from "../ModelSelector";
import { cheapModelValueToSelection } from "./use-model-selection";

const log = createLogger("CreateLoopForm");

export interface UseTitleGenerationReturn {
  generatingTitle: boolean;
  handleGenerateTitle: () => Promise<void>;
}

export function useTitleGeneration({
  selectedWorkspaceId,
  selectedModel,
  selectedCheapModel,
  nameRef,
  promptRef,
  setName,
}: {
  selectedWorkspaceId: string | undefined;
  selectedModel: string;
  selectedCheapModel: string;
  nameRef: React.MutableRefObject<string>;
  promptRef: React.MutableRefObject<string>;
  setName: (v: string) => void;
}): UseTitleGenerationReturn {
  const [generatingTitle, setGeneratingTitle] = useState(false);
  const toast = useToast();

  const handleGenerateTitle = useCallback(async () => {
    if (!selectedWorkspaceId || !promptRef.current.trim()) {
      return;
    }

    const parsedModel = parseModelKey(selectedModel);
    if (!parsedModel) {
      log.error("Failed to generate loop title: invalid selected model", { selectedModel });
      toast.error("Select a valid model before generating a title.");
      return;
    }

    setGeneratingTitle(true);
    try {
      const generatedTitle = await generateLoopTitleApi({
        workspaceId: selectedWorkspaceId,
        prompt: promptRef.current.trim(),
        model: {
          providerID: parsedModel.providerID,
          modelID: parsedModel.modelID,
          variant: parsedModel.variant,
        },
        cheapModel: cheapModelValueToSelection(selectedCheapModel),
      });
      setName(generatedTitle);
      nameRef.current = generatedTitle;
    } catch (error) {
      log.error("Failed to generate loop title:", error);
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setGeneratingTitle(false);
    }
  }, [selectedCheapModel, selectedModel, selectedWorkspaceId, nameRef, promptRef, setName, toast]);

  return { generatingTitle, handleGenerateTitle };
}
