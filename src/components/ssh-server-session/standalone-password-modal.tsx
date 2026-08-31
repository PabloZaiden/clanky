import { Modal } from "@pablozaiden/webapp/web";
import { Button, PASSWORD_INPUT_PROPS } from "../common";

export interface StandalonePasswordModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: () => void;
  password: string;
  onPasswordChange: (password: string) => void;
  pendingAction: "terminal" | "delete" | null;
  hasPersistentSession: boolean;
}

export function StandalonePasswordModal({
  isOpen,
  onClose,
  onSubmit,
  password,
  onPasswordChange,
  pendingAction,
  hasPersistentSession,
}: StandalonePasswordModalProps) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="SSH password required"
      description={hasPersistentSession
        ? "Standalone persistent SSH sessions need the password from this browser before they can connect or be deleted."
        : "Standalone direct SSH sessions need the password from this browser before they can connect."}
      size="sm"
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onSubmit}>
            Continue
          </Button>
        </>
      )}
    >
      <div className="space-y-3">
        <p className="text-sm text-gray-600 dark:text-gray-300">
          {pendingAction === "delete"
            ? hasPersistentSession
              ? "Enter the SSH password to delete the remote persistent session and local metadata."
              : "Enter the SSH password to delete the standalone session metadata."
            : "Enter the SSH password to open the standalone terminal session."}
        </p>
        <div>
          <label
            htmlFor="standalone-session-password"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300"
          >
            SSH password
          </label>
          <input
            id="standalone-session-password"
            type="password"
            value={password}
            onChange={(event) => onPasswordChange(event.target.value)}
            className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-300 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100 dark:focus:ring-gray-600"
            {...PASSWORD_INPUT_PROPS}
          />
        </div>
      </div>
    </Modal>
  );
}
