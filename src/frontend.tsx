/**
 * This file is the entry point for the React app, it sets up the root
 * element and renders the App component to the DOM.
 *
 * It is included in `src/index.html`.
 */

import { createRoot } from "react-dom/client";
import { configureClientRuntime } from "@ralpher/client-sdk/public-path";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ToastProvider } from "./components/common/Toast";

function start() {
  configureClientRuntime({
    apiBaseUrl: Bun.env["BUN_PUBLIC_RALPHER_API_BASE_URL"],
    wsBaseUrl: Bun.env["BUN_PUBLIC_RALPHER_WS_BASE_URL"],
    publicBasePath: Bun.env["BUN_PUBLIC_RALPHER_PUBLIC_BASE_PATH"],
  });
  const root = createRoot(document.getElementById("root")!);
  root.render(
    <ErrorBoundary>
      <ToastProvider>
        <App />
      </ToastProvider>
    </ErrorBoundary>
  );
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start);
} else {
  start();
}
