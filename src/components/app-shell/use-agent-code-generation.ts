import { useCallback, useEffect, useRef, useState } from "react";
import type { Agent, Chat, DeterministicCodeDiagnostic, Workspace } from "@/shared";
import type { GenerateAgentCodeRequest } from "@/contracts/schemas";
import type { MessageImageAttachment } from "@/shared/message-attachments";
import { useToast } from "@pablozaiden/webapp/web";
import { apiRequest } from "../../lib/api-client";
import { isAbortError } from "../../lib/request-lifecycle";
import { parseModelKey } from "../ModelSelector";
import type { AgentFormMode } from "./use-agent-form-state";
import type { UseAgentsResult } from "../../hooks/useAgents";

function waitForNextPaint(): Promise<void> {
  if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

type AgentGenerationOperationKind = "initial" | "follow-up";

interface ActiveAgentGenerationOperation {
  id: number;
  kind: AgentGenerationOperationKind;
  controller: AbortController;
}

function createGenerationAbortError(): DOMException {
  return new DOMException("Code generation was cancelled", "AbortError");
}

export interface UseAgentCodeGenerationOptions {
  mode: AgentFormMode;
  agent: Agent | null;
  name: string;
  prompt: string;
  selectedWorkspace: Workspace | null;
  modelKey: string;
  onPrepareGenerateAgentCode: UseAgentsResult["prepareGenerateAgentCode"];
  onGenerateAgentCode: UseAgentsResult["generateAgentCode"];
  onCodeChanged: () => void;
}

export interface AgentGenerationMessageOptions {
  message?: string;
  attachments: MessageImageAttachment[];
}

export interface UseAgentCodeGenerationResult {
  code: string;
  codeDiagnostics: DeterministicCodeDiagnostic[];
  generationChatId: string | null;
  isGeneratingCode: boolean;
  setCode: (nextCode: string) => void;
  invalidatePendingDraft: () => void;
  generateCode: () => Promise<void>;
  sendGenerationMessage: (options: AgentGenerationMessageOptions) => Promise<Chat>;
  cancelGeneration: () => void;
}

export function useAgentCodeGeneration({
  mode,
  agent,
  name,
  prompt,
  selectedWorkspace,
  modelKey,
  onPrepareGenerateAgentCode,
  onGenerateAgentCode,
  onCodeChanged,
}: UseAgentCodeGenerationOptions): UseAgentCodeGenerationResult {
  const toast = useToast();
  const toastError = toast.error;
  const toastSuccess = toast.success;
  const [code, setCodeState] = useState(agent?.config.code ?? "");
  const [codeDiagnostics, setCodeDiagnostics] = useState<DeterministicCodeDiagnostic[]>([]);
  const [generationChatId, setGenerationChatId] = useState<string | null>(
    agent?.config.generationChatId ?? null,
  );
  const [isGeneratingCode, setIsGeneratingCode] = useState(false);
  const activeGenerationOperationRef = useRef<ActiveAgentGenerationOperation | null>(null);
  const nextGenerationOperationIdRef = useRef(0);
  const codeRevisionRef = useRef(0);
  const localCodeEditRef = useRef(false);

  useEffect(() => () => {
    activeGenerationOperationRef.current?.controller.abort();
  }, []);

  useEffect(() => {
    if (mode !== "edit" || !agent) {
      return;
    }
    const controller = new AbortController();
    const requestCodeRevision = codeRevisionRef.current;
    void (async () => {
      try {
        const draft = await apiRequest<{ code?: string }>(`/api/agents/${agent.config.id}/code/draft`, {
          signal: controller.signal,
          action: "Load agent generation draft",
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
  }, [agent?.config.id, mode, toastError]);

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
    kind: AgentGenerationOperationKind,
  ): ActiveAgentGenerationOperation | null => {
    if (activeGenerationOperationRef.current) {
      return null;
    }
    const operation: ActiveAgentGenerationOperation = {
      id: nextGenerationOperationIdRef.current + 1,
      kind,
      controller: new AbortController(),
    };
    nextGenerationOperationIdRef.current = operation.id;
    activeGenerationOperationRef.current = operation;
    setIsGeneratingCode(true);
    return operation;
  }, []);

  const releaseGenerationOperation = useCallback((operation: ActiveAgentGenerationOperation): void => {
    if (activeGenerationOperationRef.current?.id !== operation.id) {
      return;
    }
    activeGenerationOperationRef.current = null;
    setIsGeneratingCode(false);
  }, []);

  const generateCode = useCallback(async (): Promise<void> => {
    const parsedGenerationModel = parseModelKey(modelKey);
    if (mode !== "edit" || !agent) {
      toastError("Save the agent before generating code");
      return;
    }
    if (!selectedWorkspace || !parsedGenerationModel) {
      toastError("Select a workspace and model before generating code");
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
      const generationRequest: GenerateAgentCodeRequest = {
        name: name.trim() || undefined,
        prompt,
        previousCode: code,
        workspaceId: selectedWorkspace.id,
        model: parsedGenerationModel,
        attachments: [],
      };
      const prepared = await onPrepareGenerateAgentCode(agent.config.id, {
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
      const generated = await onGenerateAgentCode({
        ...generationRequest,
        chatId: prepared.chatId,
        generationMode: "initial",
      }, agent.config.id, {
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
          : "Code draft generated. Save the agent to enable it.",
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
    agent,
    applyGeneratedCode,
    code,
    mode,
    name,
    onGenerateAgentCode,
    onPrepareGenerateAgentCode,
    prompt,
    releaseGenerationOperation,
    selectedWorkspace,
    modelKey,
    toastError,
    toastSuccess,
  ]);

  const sendGenerationMessage = useCallback(async (
    options: AgentGenerationMessageOptions,
  ): Promise<Chat> => {
    if (!agent || !generationChatId || !selectedWorkspace) {
      throw new Error("Save the agent and start a generation conversation first");
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
      const generated = await onGenerateAgentCode({
        name: name.trim() || undefined,
        prompt,
        previousCode: code,
        workspaceId: selectedWorkspace.id,
        model: parsedGenerationModel,
        chatId: generationChatId,
        message: options.message,
        attachments: options.attachments,
      }, agent.config.id, {
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
    agent,
    applyGeneratedCode,
    code,
    generationChatId,
    modelKey,
    name,
    onGenerateAgentCode,
    prompt,
    releaseGenerationOperation,
    selectedWorkspace,
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
