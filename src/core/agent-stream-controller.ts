/**
 * Shared ACP turn lifecycle for chat and task streams.
 *
 * Domain services own transcript materialization and state transitions. This
 * controller owns the transport boundary: subscribe before prompting, consume
 * events until the turn ends, and close the stream on every exit path.
 */

import type { AgentEvent, PromptInput } from "../backends/types";
import type { EventStream } from "../utils/event-stream";

const DEFAULT_AGENT_STREAM_ACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;

export interface AgentStreamBackend {
  subscribeToEvents(sessionId: string): Promise<EventStream<AgentEvent>>;
  sendPromptAsync(sessionId: string, prompt: PromptInput): Promise<void>;
}

export interface AgentStreamEventResult {
  stop?: boolean;
}

export interface AgentStreamStartOptions {
  sessionId: string;
  prompt: PromptInput;
  activityTimeoutMs?: number | null;
}

export interface AgentStreamRunOptions {
  shouldStop?: () => boolean | Promise<boolean>;
  onEvent: (
    event: AgentEvent,
  ) => AgentStreamEventResult | void | Promise<AgentStreamEventResult | void>;
}

export interface AgentStreamResult {
  lastEvent: AgentEvent | null;
  stopped: boolean;
}

export interface AgentStreamHandle {
  startPrompt(): Promise<boolean>;
  consume(options: AgentStreamRunOptions): Promise<AgentStreamResult>;
  close(): void;
}

/**
 * Owns one ACP prompt/response turn. Calling `start()` creates a cancellable
 * handle before any asynchronous startup. The subscription and prompt are
 * started when the returned handle's `startPrompt()` method is called,
 * followed by event consumption through `consume()`. This lets callers
 * register their active-stream state before startup can continue.
 */
export class AgentStreamController {
  constructor(private readonly backend: AgentStreamBackend) {}

  start(options: AgentStreamStartOptions): AgentStreamHandle {
    let stream: EventStream<AgentEvent> | null = null;
    let closed = false;
    let startPromise: Promise<boolean> | undefined;
    let consumePromise: Promise<AgentStreamResult> | undefined;
    const startPrompt = (): Promise<boolean> => {
      startPromise ??= this.startPrompt(options, {
        isClosed: () => closed,
        setStream: (nextStream) => {
          stream = nextStream;
        },
      });
      return startPromise;
    };
    const consume = (runOptions: AgentStreamRunOptions): Promise<AgentStreamResult> => {
      consumePromise ??= (async () => {
        if (!await startPrompt() || !stream) {
          return { lastEvent: null, stopped: true };
        }
        return this.consume(stream, options.activityTimeoutMs, runOptions, () => closed);
      })();
      return consumePromise;
    };

    return {
      startPrompt,
      consume,
      close: () => {
        closed = true;
        stream?.close();
      },
    };
  }

  private async startPrompt(
    options: AgentStreamStartOptions,
    context: {
      isClosed: () => boolean;
      setStream: (stream: EventStream<AgentEvent>) => void;
    },
  ): Promise<boolean> {
    if (context.isClosed()) {
      return false;
    }
    let stream: EventStream<AgentEvent> | null = null;
    try {
      stream = await this.backend.subscribeToEvents(options.sessionId);
      context.setStream(stream);
      if (context.isClosed()) {
        stream.close();
        return false;
      }

      await this.backend.sendPromptAsync(options.sessionId, options.prompt);
      if (context.isClosed()) {
        stream.close();
        return false;
      }
      return true;
    } catch (error) {
      stream?.close();
      throw error;
    }
  }

  private async consume(
    stream: EventStream<AgentEvent>,
    activityTimeoutMsOption: number | null | undefined,
    options: AgentStreamRunOptions,
    isClosed: () => boolean,
  ): Promise<AgentStreamResult> {
    const activityTimeoutMs = activityTimeoutMsOption === undefined
      ? DEFAULT_AGENT_STREAM_ACTIVITY_TIMEOUT_MS
      : activityTimeoutMsOption;
    let lastEvent: AgentEvent | null = null;

    try {
      let event = await this.nextEvent(stream, activityTimeoutMs);
      while (event !== null) {
        if (isClosed() || (options.shouldStop && await options.shouldStop())) {
          return { lastEvent, stopped: true };
        }

        lastEvent = event;
        const result = await options.onEvent(event);
        if (
          result?.stop === true
          || event.type === "message.complete"
          || event.type === "error"
        ) {
          return { lastEvent, stopped: true };
        }

        event = await this.nextEvent(stream, activityTimeoutMs);
      }

      return { lastEvent, stopped: true };
    } finally {
      stream.close();
    }
  }

  private nextEvent(
    stream: EventStream<AgentEvent>,
    activityTimeoutMs: number | null,
  ): Promise<AgentEvent | null> {
    if (activityTimeoutMs === null) {
      return stream.next();
    }
    return nextWithTimeout(stream, activityTimeoutMs);
  }
}

/**
 * Read one event with a bounded inactivity timeout.
 */
export async function nextWithTimeout<T>(
  stream: Pick<EventStream<T>, "next">,
  timeoutMs: number,
): Promise<T | null> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`No activity for ${Math.round(timeoutMs / 1000)} seconds`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([stream.next(), timeoutPromise]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}
