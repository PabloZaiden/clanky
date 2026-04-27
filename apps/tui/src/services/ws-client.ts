import { connectWsCommand, type CliWsCloseResult, type CliWsMessageEvent } from "@ralpher/client-sdk";
import type { ChatEvent, LoopEvent } from "@ralpher/shared";

export interface SubscriptionHandlers<TEvent> {
  onOpen?: () => void;
  onEvent: (event: TEvent) => void;
  onError?: (error: Error) => void;
  onClose?: (result: CliWsCloseResult) => void;
}

export class WsClient {
  async subscribeLoop(loopId: string, handlers: SubscriptionHandlers<LoopEvent>): Promise<() => void> {
    return await this.subscribe({ loopId }, handlers);
  }

  async subscribeChat(chatId: string, handlers: SubscriptionHandlers<ChatEvent>): Promise<() => void> {
    return await this.subscribe({ chatId }, handlers);
  }

  private async subscribe<TEvent>(
    command: { loopId?: string; chatId?: string },
    handlers: SubscriptionHandlers<TEvent>,
  ): Promise<() => void> {
    const connection = await connectWsCommand(
      command,
      {
        fetchFn: fetch,
        now: () => new Date(),
      },
    );

    if (!connection) {
      throw new Error("Not logged in. Run the Ralpher CLI auth flow before opening the TUI.");
    }

    let closed = false;

    const handleMessage = (event?: unknown) => {
      if (closed) {
        return;
      }

      const data = (event as CliWsMessageEvent | undefined)?.data;
      if (typeof data !== "string") {
        handlers.onError?.(new Error("Received a non-text WebSocket event."));
        return;
      }

      try {
        handlers.onEvent(JSON.parse(data) as TEvent);
      } catch (error) {
        handlers.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    };

    const handleError = () => {
      if (closed) {
        return;
      }
      handlers.onError?.(new Error("WebSocket connection error."));
    };

    connection.socket.addEventListener("message", handleMessage);
    connection.socket.addEventListener("error", handleError);
    handlers.onOpen?.();

    void connection.closePromise.then((result) => {
      if (closed) {
        return;
      }
      closed = true;
      connection.socket.removeEventListener("message", handleMessage);
      connection.socket.removeEventListener("error", handleError);
      handlers.onClose?.(result);
    });

    return () => {
      if (closed) {
        return;
      }
      closed = true;
      connection.socket.removeEventListener("message", handleMessage);
      connection.socket.removeEventListener("error", handleError);
      if (connection.socket.readyState < 2) {
        connection.socket.close(1000, "TUI subscription closed");
      }
    };
  }
}
