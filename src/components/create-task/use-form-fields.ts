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
import { getTaskCreationDefaults } from "@/shared/task-creation";
import type { CreateTaskFormProps } from "./types";

type InitialTaskData = CreateTaskFormProps["initialTaskData"];

export interface UseFormFieldsReturn {
  nameRef: React.MutableRefObject<string>;
  promptRef: React.MutableRefObject<string>;
  name: string;
  setName: (v: string) => void;
  prompt: string;
  setPrompt: (v: string) => void;
  issueNumber: string;
  setIssueNumber: (v: string) => void;
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
  isEditing,
  initialTaskData,
}: {
  isEditing: boolean;
  initialTaskData: InitialTaskData;
}): UseFormFieldsReturn {
  const nameRef = useRef(initialTaskData?.name ?? "");
  const promptRef = useRef(initialTaskData?.prompt ?? "");
  const initialPlanningPreferencesRef = useRef<NewTaskPlanningPreferences | null | undefined>(
    undefined
  );
  if (initialPlanningPreferencesRef.current === undefined) {
    initialPlanningPreferencesRef.current = isEditing
      ? null
      : getStoredNewTaskPlanningPreferences();
  }
  const storedPlanningPreferences = initialPlanningPreferencesRef.current;
  const defaults = getTaskCreationDefaults({
    initial: initialTaskData,
    planningPreferences: storedPlanningPreferences,
    isEditing,
  });

  const [name, setName] = useState(initialTaskData?.name ?? "");
  const [prompt, setPrompt] = useState(initialTaskData?.prompt ?? "");
  const [issueNumber, setIssueNumber] = useState(
    initialTaskData?.issueNumber?.toString() ?? "",
  );
  const [maxIterations, setMaxIterations] = useState<string>(
    defaults.maxIterations?.toString() ?? ""
  );
  const [maxConsecutiveErrors, setMaxConsecutiveErrors] = useState<string>(
    defaults.maxConsecutiveErrors.toString()
  );
  const [activityTimeoutSeconds, setActivityTimeoutSeconds] = useState<string>(
    defaults.activityTimeoutSeconds.toString()
  );
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [autoAcceptPlan, setAutoAcceptPlan] = useState(defaults.autoAcceptPlan);
  const [fullyAutonomous, setFullyAutonomous] = useState(defaults.fullyAutonomous);
  const [useWorktree, setUseWorktree] = useState(defaults.useWorktree);
  const [clearPlanningFolder, setClearPlanningFolder] = useState(defaults.clearPlanningFolder);
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
    if (isEditing) {
      return;
    }

    saveStoredNewTaskPlanningPreferences({
      autoAcceptPlan,
      fullyAutonomous,
    });
  }, [isEditing, autoAcceptPlan, fullyAutonomous]);

  return {
    nameRef,
    promptRef,
    name,
    setName,
    prompt,
    setPrompt,
    issueNumber,
    setIssueNumber,
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
