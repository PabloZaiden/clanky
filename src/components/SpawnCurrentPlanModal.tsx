import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Modal } from "./common";

export interface SpawnCurrentPlanModalProps {
  isOpen: boolean;
  submitting: boolean;
  workspaceDirectory: string;
  initialPlanFilePath?: string;
  onClose: () => void;
  onSubmit: (planFilePath: string) => Promise<void>;
}

export function SpawnCurrentPlanModal({
  isOpen,
  submitting,
  workspaceDirectory,
  initialPlanFilePath = "",
  onClose,
  onSubmit,
}: SpawnCurrentPlanModalProps) {
  const [planFilePath, setPlanFilePath] = useState(initialPlanFilePath);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setPlanFilePath(initialPlanFilePath);
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [initialPlanFilePath, isOpen]);

  async function handleSubmit(event?: FormEvent<HTMLFormElement>): Promise<void> {
    event?.preventDefault();
    await onSubmit(planFilePath.trim());
  }

  function handleClose(): void {
    if (submitting) {
      return;
    }

    onClose();
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Spawn loop from plan file"
      description="Enter an absolute plan path, or leave the field blank to use .ralph-planning/plan.md from the current chat workspace."
      size="sm"
      showCloseButton={!submitting}
      closeOnOverlayClick={!submitting}
      footer={(
        <>
          <Button variant="ghost" onClick={handleClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="spawn-current-plan-modal-form"
            loading={submitting}
          >
            Spawn loop
          </Button>
        </>
      )}
    >
      <form id="spawn-current-plan-modal-form" className="space-y-3" onSubmit={(event) => void handleSubmit(event)}>
        <div>
          <label
            htmlFor="spawn-current-plan-path"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300"
          >
            Plan file path
          </label>
          <input
            ref={inputRef}
            id="spawn-current-plan-path"
            type="text"
            value={planFilePath}
            onChange={(event) => setPlanFilePath(event.target.value)}
            disabled={submitting}
            placeholder="/workspaces/shared/feature-plan.md"
            className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-300 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100 dark:focus:ring-gray-600"
          />
        </div>
        <p className="text-sm text-gray-600 dark:text-gray-300">
          Blank input uses <code className="rounded bg-gray-100 px-1 py-0.5 text-xs dark:bg-neutral-700">{workspaceDirectory}/.ralph-planning/plan.md</code>.
        </p>
      </form>
    </Modal>
  );
}
