import { useEffect, useRef, useState, type FormEvent } from "react";
import type { SshServer } from "@/shared";
import { Modal } from "@pablozaiden/webapp/web";
import { Button, PASSWORD_INPUT_PROPS } from "./common";
import { useToast } from "../hooks";

export interface CreateSshServerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (
    request: { name: string; address: string; username: string; repositoriesBasePath?: string | null },
    password?: string,
  ) => Promise<SshServer | null>;
  initialServer?: SshServer | null;
}

export function CreateSshServerModal({
  isOpen,
  onClose,
  onSubmit,
  initialServer,
}: CreateSshServerModalProps) {
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    setName(initialServer?.config.name ?? "");
    setAddress(initialServer?.config.address ?? "");
    setUsername(initialServer?.config.username ?? "");
    setPassword("");
  }, [initialServer, isOpen]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || !address.trim() || !username.trim()) {
      toast.error("Name, address, and username are required.");
      return;
    }
    try {
      setSubmitting(true);
      const server = await onSubmit({
        name: name.trim(),
        address: address.trim(),
        username: username.trim(),
      }, password.trim() || undefined);
      if (!server) {
        return;
      }
      onClose();
    } catch (error) {
      toast.error(String(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={initialServer ? "Edit SSH Server" : "New SSH Server"}
      description="Register a standalone SSH server. The server stores only the name, address, and username."
      size="md"
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={() => formRef.current?.requestSubmit()} loading={submitting}>
            {initialServer ? "Save Server" : "Create Server"}
          </Button>
        </>
      )}
    >
      <form ref={formRef} className="space-y-4" onSubmit={(event) => void handleSubmit(event)}>
        <div>
          <label htmlFor="ssh-server-name" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            Server name
          </label>
          <input
            id="ssh-server-name"
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100"
          />
        </div>
        <div>
          <label htmlFor="ssh-server-address" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            Address
          </label>
          <input
            id="ssh-server-address"
            type="text"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100"
          />
        </div>
        <div>
          <label htmlFor="ssh-server-username" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            Username
          </label>
          <input
            id="ssh-server-username"
            type="text"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100"
          />
        </div>
        <div>
          <label htmlFor="ssh-server-password" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            Browser-only password {initialServer ? "(optional)" : "(optional now, can be added later)"}
          </label>
          <input
            id="ssh-server-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-neutral-700 dark:text-gray-100"
            {...PASSWORD_INPUT_PROPS}
          />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Passwords are encrypted in the browser and never stored on the Clanky server.
          </p>
        </div>
      </form>
    </Modal>
  );
}
