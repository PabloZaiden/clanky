import { runMacWorkerPermissionPreflight } from "./macos-worker-permissions";
import type {
  MacWorkerPermissionPreflightRequest,
  MacWorkerPermissionPreflightWorkerMessage,
} from "./macos-worker-permissions";

declare const self: Worker;

self.onmessage = (event: MessageEvent<MacWorkerPermissionPreflightRequest>) => {
  const { homeDirectory } = event.data;
  if (typeof homeDirectory !== "string" || homeDirectory.length === 0) {
    self.postMessage({
      type: "error",
      error: "The macOS permission preflight requires a home directory.",
    } satisfies MacWorkerPermissionPreflightWorkerMessage);
    process.exit(1);
  }

  void runMacWorkerPermissionPreflight({
    homeDirectory,
    output: (message) => {
      self.postMessage({
        type: "output",
        message,
      } satisfies MacWorkerPermissionPreflightWorkerMessage);
    },
  }).then(
    () => {
      self.postMessage({
        type: "complete",
      } satisfies MacWorkerPermissionPreflightWorkerMessage);
      process.exit(0);
    },
    (error: unknown) => {
      self.postMessage({
        type: "error",
        error: String(error),
      } satisfies MacWorkerPermissionPreflightWorkerMessage);
      process.exit(1);
    },
  );
};
