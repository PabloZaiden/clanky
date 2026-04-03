import { useCallback, type FormEvent } from "react";
import { Button, Modal, PASSWORD_INPUT_PROPS } from "../common";

interface ServerPasswordModalProps {
  isOpen: boolean;
  serverName: string;
  password: string;
  error: string | null;
  submitting: boolean;
  onPasswordChange: (password: string) => void;
  onClose: () => void;
  onSubmit: () => Promise<void>;
}

export function ServerPasswordModal({
  isOpen,
  serverName,
  password,
  error,
  submitting,
  onPasswordChange,
  onClose,
  onSubmit,
}: ServerPasswordModalProps) {
  const handleSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void onSubmit();
  }, [onSubmit]);

  const handleClose = useCallback(() => {
    if (submitting) {
      return;
    }

    onClose();
  }, [onClose, submitting]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="SSH password required"
      description={`Enter the SSH password for ${serverName} before opening its code explorer.`}
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
            form="server-password-modal-form"
            loading={submitting}
            disabled={!password.trim()}
          >
            Continue
          </Button>
        </>
      )}
    >
      <form id="server-password-modal-form" className="space-y-3" onSubmit={handleSubmit}>
        <div>
          <label
            htmlFor="server-password-modal-input"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300"
          >
            SSH password
          </label>
          <input
            id="server-password-modal-input"
            type="password"
            value={password}
            onChange={(event) => onPasswordChange(event.target.value)}
            className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-300 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100 dark:focus:ring-gray-600"
            {...PASSWORD_INPUT_PROPS}
          />
        </div>
        {error ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>
        ) : (
          <p className="text-sm text-gray-600 dark:text-gray-300">
            The password is stored encrypted in this browser and exchanged for a temporary server credential.
          </p>
        )}
      </form>
    </Modal>
  );
}
