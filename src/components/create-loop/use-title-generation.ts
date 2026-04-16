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
  generateTitle: () => Promise<string | null>;
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

  const generateTitle = useCallback(async (): Promise<string | null> => {
    if (generatingTitle) {
      return null;
    }

    if (!selectedWorkspaceId || !promptRef.current.trim()) {
      return null;
    }

    const parsedModel = parseModelKey(selectedModel);
    if (!parsedModel) {
      log.error("Failed to generate loop title: invalid selected model", { selectedModel });
      toast.error("Select a valid model before generating a title.");
      return null;
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
      const trimmedTitle = generatedTitle.trim();
      if (!trimmedTitle) {
        log.warn("Loop title generation returned an empty title");
        toast.error("Failed to generate a title.");
        return null;
      }
      setName(trimmedTitle);
      nameRef.current = trimmedTitle;
      return trimmedTitle;
    } catch (error) {
      log.error("Failed to generate loop title:", error);
      toast.error(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      setGeneratingTitle(false);
    }
  }, [generatingTitle, selectedCheapModel, selectedModel, selectedWorkspaceId, nameRef, promptRef, setName, toast]);

  const handleGenerateTitle = useCallback(async () => {
    await generateTitle();
  }, [generateTitle]);

  return { generatingTitle, generateTitle, handleGenerateTitle };
}
