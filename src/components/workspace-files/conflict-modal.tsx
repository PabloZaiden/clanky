import { Modal } from "@pablozaiden/webapp/web";
import { Button } from "../common";

interface WorkspaceFileConflictModalProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export function WorkspaceFileConflictModal({
  isOpen,
  title,
  message,
  confirmLabel,
  cancelLabel = "Cancel",
  onCancel,
  onConfirm,
}: WorkspaceFileConflictModalProps) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      title={title}
      size="sm"
      footer={(
        <>
          <Button variant="ghost" onClick={onCancel}>{cancelLabel}</Button>
          <Button variant="primary" onClick={onConfirm}>{confirmLabel}</Button>
        </>
      )}
    >
      <p className="text-sm text-gray-600 dark:text-gray-300">{message}</p>
    </Modal>
  );
}
