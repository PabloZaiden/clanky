import { Modal } from "@pablozaiden/webapp/web";
import { Button } from "../common";

export interface TerminalSessionModeModalProps {
  isOpen: boolean;
  submitting: boolean;
  onClose: () => void;
  onSelect: (useTmux: boolean) => void | Promise<void>;
}

export function TerminalSessionModeModal({
  isOpen,
  submitting,
  onClose,
  onSelect,
}: TerminalSessionModeModalProps) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={() => {
        if (!submitting) {
          onClose();
        }
      }}
      title="Create terminal"
      description="Choose how this terminal should start."
      size="sm"
      showCloseButton={!submitting}
      closeOnOverlayClick={!submitting}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant="secondary"
            loading={submitting}
            onClick={() => {
              void onSelect(false);
            }}
          >
            Without tmux
          </Button>
          <Button
            variant="primary"
            loading={submitting}
            onClick={() => {
              void onSelect(true);
            }}
          >
            With tmux
          </Button>
        </>
      )}
    >
      <p className="text-sm text-gray-600 dark:text-gray-300">
        Clanky will use dtach when available and fall back to a direct shell if the persistent session cannot be started.
      </p>
    </Modal>
  );
}
