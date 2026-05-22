/**
 * Hook for managing port-forward form state and action handlers in TaskDetails.
 */

import { useState } from "react";
import type { ToastContextValue } from "../../hooks/useToast";
import type { PortForward } from "../../types";
import type { CreatePortForwardRequest } from "../../hooks/taskActions";
import { appAbsoluteUrl, appPath } from "../../lib/public-path";
import { writeTextToClipboard } from "../../utils";

interface UsePortForwardActionsOptions {
  taskId: string;
  toast: ToastContextValue;
  createForward: (request: CreatePortForwardRequest) => Promise<PortForward | null>;
  deleteForward: (forwardId: string) => Promise<boolean>;
}

export interface UsePortForwardActionsResult {
  newForwardPort: string;
  setNewForwardPort: React.Dispatch<React.SetStateAction<string>>;
  creatingForward: boolean;
  handleCreateForward: () => Promise<void>;
  handleDeleteForward: (forwardId: string) => Promise<void>;
  handleCopyForwardUrl: (forwardId: string) => Promise<void>;
  handleOpenForward: (forwardId: string) => void;
}

export function usePortForwardActions({
  taskId,
  toast,
  createForward,
  deleteForward,
}: UsePortForwardActionsOptions): UsePortForwardActionsResult {
  const [newForwardPort, setNewForwardPort] = useState("");
  const [creatingForward, setCreatingForward] = useState(false);

  async function handleCreateForward() {
    const remotePort = Number(newForwardPort);
    if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
      toast.error("Enter a valid remote port between 1 and 65535");
      return;
    }

    setCreatingForward(true);
    try {
      const forward = await createForward({ remotePort });
      if (!forward) {
        toast.error("Failed to create port forward");
        return;
      }
      setNewForwardPort("");
    } finally {
      setCreatingForward(false);
    }
  }

  async function handleDeleteForward(forwardId: string) {
    const success = await deleteForward(forwardId);
    if (!success) {
      toast.error("Failed to delete port forward");
    }
  }

  async function handleCopyForwardUrl(forwardId: string) {
    const absoluteUrl = appAbsoluteUrl(`/task/${taskId}/port/${forwardId}/`);
    try {
      await writeTextToClipboard(absoluteUrl);
    } catch (error) {
      toast.error(`Failed to copy URL: ${String(error)}`);
    }
  }

  function handleOpenForward(forwardId: string) {
    window.open(appPath(`/task/${taskId}/port/${forwardId}/`), "_blank", "noopener,noreferrer");
  }

  return {
    newForwardPort,
    setNewForwardPort,
    creatingForward,
    handleCreateForward,
    handleDeleteForward,
    handleCopyForwardUrl,
    handleOpenForward,
  };
}
