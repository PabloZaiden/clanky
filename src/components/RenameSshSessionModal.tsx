/**
 * Modal component for renaming an SSH session.
 */

import { useEffect, useRef, useState } from "react";
import { Modal } from "@pablozaiden/webapp/web";
import { Button } from "./common";

export interface RenameSshSessionModalProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** Callback when modal should close */
  onClose: () => void;
  /** Current SSH session name */
  currentName: string;
  /** Callback to rename the SSH session */
  onRename: (newName: string) => Promise<void>;
}

export function RenameSshSessionModal({
  isOpen,
  onClose,
  currentName,
  onRename,
}: RenameSshSessionModalProps) {
  const [name, setName] = useState(currentName);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setName(currentName);
      setError(null);
      setLoading(false);
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [currentName, isOpen]);

  function validateName(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) {
      return "Name cannot be empty";
    }
    if (trimmed.length > 100) {
      return "Name cannot exceed 100 characters";
    }
    return null;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    const trimmedName = name.trim();
    const validationError = validateName(trimmedName);
    if (validationError) {
      setError(validationError);
      return;
    }

    if (trimmedName === currentName) {
      onClose();
      return;
    }

    setLoading(true);
    setError(null);
    try {
      await onRename(trimmedName);
      onClose();
    } catch (renameError) {
      setError(String(renameError));
    } finally {
      setLoading(false);
    }
  }

  function handleCancel() {
    if (!loading) {
      onClose();
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleCancel}
      title="Rename SSH Session"
      size="sm"
      closeOnOverlayClick={!loading}
      footer={(
        <>
          <Button variant="ghost" onClick={handleCancel} disabled={loading}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            loading={loading}
            disabled={!name.trim() || loading}
          >
            Save
          </Button>
        </>
      )}
    >
      <form onSubmit={handleSubmit}>
        <div>
          <label
            htmlFor="ssh-session-name"
            className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
          >
            SSH Session Name
          </label>
          <input
            ref={inputRef}
            id="ssh-session-name"
            type="text"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            disabled={loading}
            maxLength={100}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-neutral-700 dark:border-gray-600 dark:text-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
            placeholder="Enter SSH session name"
          />
          {error && (
            <p className="mt-1 text-sm text-red-600 dark:text-red-400">
              {error}
            </p>
          )}
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {name.trim().length}/100 characters
          </p>
        </div>
      </form>
    </Modal>
  );
}
