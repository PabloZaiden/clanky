/**
 * useFormFields — manages core text and option field state for CreateLoopForm.
 *
 * Handles name, prompt, and all boolean/numeric option fields, plus sync
 * effects that keep them in sync when initialLoopData changes.
 */

import { useState, useEffect, useRef } from "react";
import { DEFAULT_LOOP_CONFIG } from "../../types/loop";
import type { CreateLoopFormProps } from "./types";

type InitialLoopData = CreateLoopFormProps["initialLoopData"];

export interface UseFormFieldsReturn {
  nameRef: React.MutableRefObject<string>;
  promptRef: React.MutableRefObject<string>;
  name: string;
  setName: (v: string) => void;
  prompt: string;
  setPrompt: (v: string) => void;
  planMode: boolean;
  setPlanMode: (v: boolean) => void;
  autoAcceptPlan: boolean;
  setAutoAcceptPlan: (v: boolean) => void;
  fullyAutonomous: boolean;
  setFullyAutonomous: (v: boolean) => void;
  useWorktree: boolean;
  setUseWorktree: (v: boolean) => void;
  clearPlanningFolder: boolean;
  setClearPlanningFolder: (v: boolean) => void;
  selectedTemplate: string;
  setSelectedTemplate: (v: string) => void;
  showAdvanced: boolean;
  setShowAdvanced: (v: boolean) => void;
  maxIterations: string;
  setMaxIterations: (v: string) => void;
  maxConsecutiveErrors: string;
  setMaxConsecutiveErrors: (v: string) => void;
  activityTimeoutSeconds: string;
  setActivityTimeoutSeconds: (v: string) => void;
}

export function useFormFields({
  initialLoopData,
}: {
  initialLoopData: InitialLoopData;
}): UseFormFieldsReturn {
  const nameRef = useRef(initialLoopData?.name ?? "");
  const promptRef = useRef(initialLoopData?.prompt ?? "");

  const [name, setName] = useState(initialLoopData?.name ?? "");
  const [prompt, setPrompt] = useState(initialLoopData?.prompt ?? "");
  const [maxIterations, setMaxIterations] = useState<string>(
    initialLoopData?.maxIterations?.toString() ?? ""
  );
  const [maxConsecutiveErrors, setMaxConsecutiveErrors] = useState<string>(
    initialLoopData?.maxConsecutiveErrors?.toString() ?? "10"
  );
  const [activityTimeoutSeconds, setActivityTimeoutSeconds] = useState<string>(
    initialLoopData?.activityTimeoutSeconds?.toString() ??
      String(DEFAULT_LOOP_CONFIG.activityTimeoutSeconds)
  );
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [planMode, setPlanMode] = useState(initialLoopData?.planMode ?? true);
  const [autoAcceptPlan, setAutoAcceptPlan] = useState(
    initialLoopData?.autoAcceptPlan ?? DEFAULT_LOOP_CONFIG.autoAcceptPlan
  );
  const [fullyAutonomous, setFullyAutonomous] = useState(
    initialLoopData
      ? (initialLoopData.fullyAutonomous ?? DEFAULT_LOOP_CONFIG.fullyAutonomous)
      : true
  );
  const [useWorktree, setUseWorktree] = useState(
    initialLoopData?.useWorktree ?? DEFAULT_LOOP_CONFIG.useWorktree
  );
  const [clearPlanningFolder, setClearPlanningFolder] = useState(
    initialLoopData?.clearPlanningFolder ?? false
  );
  const [selectedTemplate, setSelectedTemplate] = useState("");

  // Sync prompt when initialLoopData changes (safety measure for component reuse)
  useEffect(() => {
    const newPrompt = initialLoopData?.prompt ?? "";
    setPrompt(newPrompt);
    promptRef.current = newPrompt;
  }, [initialLoopData?.prompt]);

  useEffect(() => {
    setName(initialLoopData?.name ?? "");
    nameRef.current = initialLoopData?.name ?? "";
  }, [initialLoopData?.name]);

  return {
    nameRef,
    promptRef,
    name,
    setName,
    prompt,
    setPrompt,
    planMode,
    setPlanMode,
    autoAcceptPlan,
    setAutoAcceptPlan,
    fullyAutonomous,
    setFullyAutonomous,
    useWorktree,
    setUseWorktree,
    clearPlanningFolder,
    setClearPlanningFolder,
    selectedTemplate,
    setSelectedTemplate,
    showAdvanced,
    setShowAdvanced,
    maxIterations,
    setMaxIterations,
    maxConsecutiveErrors,
    setMaxConsecutiveErrors,
    activityTimeoutSeconds,
    setActivityTimeoutSeconds,
  };
}
