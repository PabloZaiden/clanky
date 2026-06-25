import { useEffect, useRef, useState, type FormEvent } from "react";
import { Modal } from "@pablozaiden/webapp/web";
import { Button } from "./common";

const DEFAULT_PLAN_FILE_PATH = ".clanky-planning/plan.md";

export interface SpawnCurrentPlanModalProps {
  isOpen: boolean;
  submitting: boolean;
  initialPlanFilePath?: string;
  onClose: () => void;
  onSubmit: (planFilePath: string) => Promise<void>;
}

export function SpawnCurrentPlanModal({
  isOpen,
  submitting,
  initialPlanFilePath = "",
  onClose,
  onSubmit,
}: SpawnCurrentPlanModalProps) {
  const [planFilePath, setPlanFilePath] = useState(initialPlanFilePath || DEFAULT_PLAN_FILE_PATH);
  const inputRef = useRef<HTMLInputElement>(null);
  const normalizedPlanFilePath = planFilePath.trim();

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setPlanFilePath(initialPlanFilePath || DEFAULT_PLAN_FILE_PATH);
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [initialPlanFilePath, isOpen]);

  async function handleSubmit(event?: FormEvent<HTMLFormElement>): Promise<void> {
    event?.preventDefault();
    if (!normalizedPlanFilePath) {
      return;
    }

    await onSubmit(normalizedPlanFilePath);
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
      title="Spawn task from plan file"
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
            disabled={!normalizedPlanFilePath}
          >
            Spawn task
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
            placeholder={DEFAULT_PLAN_FILE_PATH}
            className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-300 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100 dark:focus:ring-gray-600"
          />
        </div>
      </form>
    </Modal>
  );
}
