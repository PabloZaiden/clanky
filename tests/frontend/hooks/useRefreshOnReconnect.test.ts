import { describe, expect, mock, test } from "bun:test";
import { renderHook, waitFor } from "@testing-library/react";
import { useRefreshOnReconnect } from "@/hooks/useRefreshOnReconnect";
import type { WebSocketConnectionStatus } from "@/hooks/useWebSocket";

interface HookProps {
  status: WebSocketConnectionStatus;
  resetKey?: string;
  enabled?: boolean;
}

describe("useRefreshOnReconnect", () => {
  test("tracks the next reconnect after resetKey changes while already open", async () => {
    const onReconnect = mock(() => {});
    const { rerender } = renderHook(
      (props: HookProps) => useRefreshOnReconnect({ ...props, onReconnect }),
      {
        initialProps: {
          status: "open",
          resetKey: "task-1",
        },
      },
    );

    rerender({
      status: "open",
      resetKey: "task-2",
    });
    rerender({
      status: "error",
      resetKey: "task-2",
    });
    rerender({
      status: "open",
      resetKey: "task-2",
    });

    await waitFor(() => {
      expect(onReconnect).toHaveBeenCalledTimes(1);
    });
  });

  test("does not refresh immediately when resetKey changes but the socket stays open", async () => {
    const onReconnect = mock(() => {});
    const { rerender } = renderHook(
      (props: HookProps) => useRefreshOnReconnect({ ...props, onReconnect }),
      {
        initialProps: {
          status: "open",
          resetKey: "task-1",
        },
      },
    );

    rerender({
      status: "open",
      resetKey: "task-2",
    });

    await waitFor(() => {
      expect(onReconnect).toHaveBeenCalledTimes(0);
    });
  });
});
