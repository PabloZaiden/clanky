import { useState } from "react";
import { Button, ConfirmModal } from "../common";

export interface RemovePasskeySectionProps {
  removingPasskey?: boolean;
  onRemovePasskey?: () => Promise<boolean>;
}

export function RemovePasskeySection({
  removingPasskey = false,
  onRemovePasskey,
}: RemovePasskeySectionProps) {
  const [removeConfirmOpen, setRemoveConfirmOpen] = useState(false);

  function handleCloseRemoveConfirm(): void {
    if (!removingPasskey) {
      setRemoveConfirmOpen(false);
    }
  }

  async function handleConfirmRemovePasskey(): Promise<void> {
    const removed = await onRemovePasskey?.();
    if (removed) {
      setRemoveConfirmOpen(false);
    }
  }

  return (
    <div>
      <p className="mb-3 text-sm text-red-600 dark:text-red-400">
        Remove the configured passkey and sign this browser out of the protected session.
      </p>
      <Button
        type="button"
        size="sm"
        variant="danger"
        loading={removingPasskey}
        disabled={!onRemovePasskey}
        onClick={() => {
          setRemoveConfirmOpen(true);
        }}
      >
        Remove passkey
      </Button>
      <ConfirmModal
        isOpen={removeConfirmOpen}
        onClose={handleCloseRemoveConfirm}
        onConfirm={() => {
          void handleConfirmRemovePasskey();
        }}
        title="Remove passkey?"
        message="This removes the configured passkey and signs this browser out of the protected session."
        confirmLabel="Remove passkey"
        loading={removingPasskey}
        variant="danger"
      />
    </div>
  );
}
