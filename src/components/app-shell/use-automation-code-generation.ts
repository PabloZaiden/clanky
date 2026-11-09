import { useCallback, useEffect, useRef, useState } from "react";
import type { Automation, Chat, DeterministicCodeDiagnostic, Workspace } from "@/shared";
import type { GenerateAutomationCodeRequest } from "@/contracts/schemas";
import type { MessageAttachment } from "@/shared/message-attachments";
import { useToast } from "@pablozaiden/webapp/web";
import { apiRequest } from "../../lib/api-client";
import { isAbortError } from "../../lib/request-lifecycle";
import { parseModelKey } from "../ModelSelector";
import type { AutomationFormMode } from "./use-automation-form-state";
import type { UseAutomationsResult } from "../../hooks/useAutomations";

function waitForNextPaint(): Promise<void> {
  if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

type AutomationGenerationOperationKind = "initial" | "follow-up";

interface ActiveAutomationGenerationOperation {
  id: number;
  kind: AutomationGenerationOperationKind;
  controller: AbortController;
}

function createGenerationAbortError(): DOMException {
  return new DOMException("Code generation was cancelled", "AbortError");
}

export interface UseAutomationCodeGenerationOptions {
  mode: AutomationFormMode;
  automation: Automation | null;
  name: string;
  prompt: string;
  selectedWorkspace: Workspace | null;
  modelKey: string;
  workspaceSelectionsReady: boolean;
  onPrepareGenerateAutomationCode: UseAutomationsResult["prepareGenerateAutomationCode"];
  onGenerateAutomationCode: UseAutomationsResult["generateAutomationCode"];
  onCodeChanged: () => void;
}

export interface AutomationGenerationMessageOptions {
  message?: string;
  attachments: MessageAttachment[];
}

export interface UseAutomationCodeGenerationResult {
  code: string;
  codeDiagnostics: DeterministicCodeDiagnostic[];
  generationChatId: string | null;
  isGeneratingCode: boolean;
  setCode: (nextCode: string) => void;
  invalidatePendingDraft: () => void;
  generateCode: () => Promise<void>;
  sendGenerationMessage: (options: AutomationGenerationMessageOptions) => Promise<Chat>;
  cancelGeneration: () => void;
}

export function useAutomationCodeGeneration({
  mode,
  automation,
  name,
  prompt,
  selectedWorkspace,
  modelKey,
  workspaceSelectionsReady,
  onPrepareGenerateAutomationCode,
  onGenerateAutomationCode,
  onCodeChanged,
}: UseAutomationCodeGenerationOptions): UseAutomationCodeGenerationResult {
  const toast = useToast();
  const toastError = toast.error;
  const toastSuccess = toast.success;
  const [code, setCodeState] = useState(automation?.config.code ?? "");
  const [codeDiagnostics, setCodeDiagnostics] = useState<DeterministicCodeDiagnostic[]>([]);
  const [generationChatId, setGenerationChatId] = useState<string | null>(
    automation?.config.generationChatId ?? null,
  );
  const [isGeneratingCode, setIsGeneratingCode] = useState(false);
  const activeGenerationOperationRef = useRef<ActiveAutomationGenerationOperation | null>(null);
  const nextGenerationOperationIdRef = useRef(0);
  const codeRevisionRef = useRef(0);
  const localCodeEditRef = useRef(false);

  useEffect(() => () => {
    activeGenerationOperationRef.current?.controller.abort();
  }, []);

  useEffect(() => {
    if (mode !== "edit" || !automation) {
      return;
    }
    const controller = new AbortController();
    const requestCodeRevision = codeRevisionRef.current;
    void (async () => {
      try {
        const draft = await apiRequest<{ code?: string }>(`/api/automations/${automation.config.id}/code/draft`, {
          signal: controller.signal,
          action: "Load automation generation draft",
          fallbackMessage: "Failed to load the generation draft",
        });
        if (
          !controller.signal.aborted
          && codeRevisionRef.current === requestCodeRevision
          && !localCodeEditRef.current
          && typeof draft.code === "string"
          && draft.code.trim()
        ) {
          codeRevisionRef.current += 1;
          setCodeState(draft.code);
        }
      } catch (draftError) {
        if (!(draftError instanceof DOMException && draftError.name === "AbortError")) {
          toastError(String(draftError));
        }
      }
    })();
    return () => controller.abort();
  }, [automation?.config.id, mode, toastError]);

  const setCode = useCallback((nextCode: string): void => {
    codeRevisionRef.current += 1;
    localCodeEditRef.current = true;
    setCodeState(nextCode);
    setCodeDiagnostics([]);
    onCodeChanged();
  }, [onCodeChanged]);

  const invalidatePendingDraft = useCallback((): void => {
    codeRevisionRef.current += 1;
  }, []);

  const applyGeneratedCode = useCallback((generated: {
    code: string;
    diagnostics: DeterministicCodeDiagnostic[];
  }): void => {
    codeRevisionRef.current += 1;
    localCodeEditRef.current = false;
    setCodeState(generated.code);
    setCodeDiagnostics(generated.diagnostics);
    onCodeChanged();
  }, [onCodeChanged]);

  const acquireGenerationOperation = useCallback((
    kind: AutomationGenerationOperationKind,
  ): ActiveAutomationGenerationOperation | null => {
    if (activeGenerationOperationRef.current) {
      return null;
    }
    const operation: ActiveAutomationGenerationOperation = {
      id: nextGenerationOperationIdRef.current + 1,
      kind,
      controller: new AbortController(),
    };
    nextGenerationOperationIdRef.current = operation.id;
    activeGenerationOperationRef.current = operation;
    setIsGeneratingCode(true);
    return operation;
  }, []);

  const releaseGenerationOperation = useCallback((operation: ActiveAutomationGenerationOperation): void => {
    if (activeGenerationOperationRef.current?.id !== operation.id) {
      return;
    }
    activeGenerationOperationRef.current = null;
    setIsGeneratingCode(false);
  }, []);

  const generateCode = useCallback(async (): Promise<void> => {
    const parsedGenerationModel = parseModelKey(modelKey);
    if (mode !== "edit" || !automation) {
      toastError("Save the automation before generating code");
      return;
    }
    if (!workspaceSelectionsReady || !selectedWorkspace || !parsedGenerationModel) {
      toastError("Select a workspace, then wait for its models and branches to finish loading and choose valid options before generating code");
      return;
    }
    const operation = acquireGenerationOperation("initial");
    if (!operation) {
      toastError("Code generation is already in progress");
      return;
    }
    const { controller } = operation;
    codeRevisionRef.current += 1;
    const requestCodeRevision = codeRevisionRef.current;
    try {
      const generationRequest: GenerateAutomationCodeRequest = {
        name: name.trim() || undefined,
        prompt,
        previousCode: code,
        workspaceId: selectedWorkspace.id,
        model: parsedGenerationModel,
        attachments: [],
      };
      const prepared = await onPrepareGenerateAutomationCode(automation.config.id, {
        workspaceId: selectedWorkspace.id,
        model: parsedGenerationModel,
      }, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        throw createGenerationAbortError();
      }
      if (!prepared) {
        throw new Error("The generation conversation could not be prepared");
      }
      if (codeRevisionRef.current !== requestCodeRevision) {
        return;
      }
      setGenerationChatId(prepared.chatId);
      await waitForNextPaint();
      if (controller.signal.aborted || codeRevisionRef.current !== requestCodeRevision) {
        return;
      }
      const generated = await onGenerateAutomationCode({
        ...generationRequest,
        chatId: prepared.chatId,
        generationMode: "initial",
      }, automation.config.id, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        throw createGenerationAbortError();
      }
      if (!generated) {
        throw new Error("The generation request ended without a code result");
      }
      if (codeRevisionRef.current !== requestCodeRevision) {
        return;
      }
      applyGeneratedCode(generated);
      if (generated.chat) {
        setGenerationChatId(generated.chat.config.id);
      }
      toastSuccess(
        generated.diagnostics.length > 0
          ? "Code draft generated with validation warnings. Fix them before saving."
          : "Code draft generated. Save the automation to enable it.",
      );
    } catch (generationError) {
      if (!isAbortError(generationError)) {
        toastError(String(generationError));
      }
    } finally {
      releaseGenerationOperation(operation);
    }
  }, [
    acquireGenerationOperation,
    automation,
    applyGeneratedCode,
    code,
    mode,
    name,
    onGenerateAutomationCode,
    onPrepareGenerateAutomationCode,
    prompt,
    releaseGenerationOperation,
    selectedWorkspace,
    modelKey,
    workspaceSelectionsReady,
    toastError,
    toastSuccess,
  ]);

  const sendGenerationMessage = useCallback(async (
    options: AutomationGenerationMessageOptions,
  ): Promise<Chat> => {
    if (!workspaceSelectionsReady || !automation || !generationChatId || !selectedWorkspace) {
      throw new Error("Save the automation and start a generation conversation first");
    }
    const parsedGenerationModel = parseModelKey(modelKey);
    if (!parsedGenerationModel) {
      throw new Error("Select a model before continuing the generation conversation");
    }
    const operation = acquireGenerationOperation("follow-up");
    if (!operation) {
      throw new Error("Code generation is already in progress");
    }
    const { controller } = operation;
    const requestCodeRevision = codeRevisionRef.current;
    try {
      const generated = await onGenerateAutomationCode({
        name: name.trim() || undefined,
        prompt,
        previousCode: code,
        workspaceId: selectedWorkspace.id,
        model: parsedGenerationModel,
        chatId: generationChatId,
        message: options.message,
        attachments: options.attachments,
      }, automation.config.id, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        throw createGenerationAbortError();
      }
      if (!generated || !generated.chat) {
        throw new Error("The generation conversation ended without a chat result");
      }
      if (codeRevisionRef.current === requestCodeRevision) {
        applyGeneratedCode(generated);
      }
      return generated.chat;
    } finally {
      releaseGenerationOperation(operation);
    }
  }, [
    acquireGenerationOperation,
    automation,
    applyGeneratedCode,
    code,
    generationChatId,
    modelKey,
    name,
    onGenerateAutomationCode,
    prompt,
    releaseGenerationOperation,
    selectedWorkspace,
    workspaceSelectionsReady,
  ]);

  const cancelGeneration = useCallback((): void => {
    const operation = activeGenerationOperationRef.current;
    if (!operation || operation.controller.signal.aborted) {
      return;
    }
    operation.controller.abort();
  }, []);

  return {
    code,
    codeDiagnostics,
    generationChatId,
    isGeneratingCode,
    setCode,
    invalidatePendingDraft,
    generateCode,
    sendGenerationMessage,
    cancelGeneration,
  };
}
