/**
 * useFormFields — manages core text and option field state for CreateTaskForm.
 *
 * Handles name, prompt, and all boolean/numeric option fields, plus sync
 * effects that keep them in sync when initialTaskData changes.
 */

import { useState, useEffect, useRef } from "react";
import {
  getStoredNewTaskPlanningPreferences,
  saveStoredNewTaskPlanningPreferences,
} from "../../lib/new-task-planning-preferences";
import type { NewTaskPlanningPreferences } from "../../lib/new-task-planning-preferences";
import { DEFAULT_TASK_CONFIG } from "../../types/task";
import type { CreateTaskFormProps } from "./types";

type InitialTaskData = CreateTaskFormProps["initialTaskData"];

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
  initialTaskData,
}: {
  initialTaskData: InitialTaskData;
}): UseFormFieldsReturn {
  const nameRef = useRef(initialTaskData?.name ?? "");
  const promptRef = useRef(initialTaskData?.prompt ?? "");
  const initialPlanningPreferencesRef = useRef<NewTaskPlanningPreferences | null | undefined>(
    undefined
  );
  if (initialPlanningPreferencesRef.current === undefined) {
    const isEditingExistingTask = initialTaskData !== null && initialTaskData !== undefined;
    initialPlanningPreferencesRef.current = isEditingExistingTask
      ? null
      : getStoredNewTaskPlanningPreferences();
  }
  const storedPlanningPreferences = initialPlanningPreferencesRef.current;

  const [name, setName] = useState(initialTaskData?.name ?? "");
  const [prompt, setPrompt] = useState(initialTaskData?.prompt ?? "");
  const [maxIterations, setMaxIterations] = useState<string>(
    initialTaskData?.maxIterations?.toString() ?? ""
  );
  const [maxConsecutiveErrors, setMaxConsecutiveErrors] = useState<string>(
    initialTaskData?.maxConsecutiveErrors?.toString() ?? "10"
  );
  const [activityTimeoutSeconds, setActivityTimeoutSeconds] = useState<string>(
    initialTaskData?.activityTimeoutSeconds?.toString() ?? ""
  );
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [planMode, setPlanMode] = useState(
    initialTaskData?.planMode ?? storedPlanningPreferences?.planMode ?? true
  );
  const [autoAcceptPlan, setAutoAcceptPlan] = useState(
    initialTaskData?.autoAcceptPlan
      ?? storedPlanningPreferences?.autoAcceptPlan
      ?? DEFAULT_TASK_CONFIG.autoAcceptPlan
  );
  const [fullyAutonomous, setFullyAutonomous] = useState(
    initialTaskData?.fullyAutonomous ?? storedPlanningPreferences?.fullyAutonomous ?? true
  );
  const [useWorktree, setUseWorktree] = useState(
    initialTaskData?.useWorktree ?? DEFAULT_TASK_CONFIG.useWorktree
  );
  const [clearPlanningFolder, setClearPlanningFolder] = useState(
    initialTaskData?.clearPlanningFolder ?? false
  );
  const [selectedTemplate, setSelectedTemplate] = useState("");

  // Sync prompt when initialTaskData changes (safety measure for component reuse)
  useEffect(() => {
    const newPrompt = initialTaskData?.prompt ?? "";
    setPrompt(newPrompt);
    promptRef.current = newPrompt;
  }, [initialTaskData?.prompt]);

  useEffect(() => {
    setName(initialTaskData?.name ?? "");
    nameRef.current = initialTaskData?.name ?? "";
  }, [initialTaskData?.name]);

  useEffect(() => {
    if (initialTaskData !== null && initialTaskData !== undefined) {
      return;
    }

    saveStoredNewTaskPlanningPreferences({
      planMode,
      autoAcceptPlan,
      fullyAutonomous,
    });
  }, [initialTaskData, planMode, autoAcceptPlan, fullyAutonomous]);

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
