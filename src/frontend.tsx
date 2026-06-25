/**
 * This file is the entry point for the React app, it sets up the root
 * element and renders the App component to the DOM.
 *
 * It is included in `src/index.html`.
 */

import { createRoot } from "react-dom/client";
import { configureClientRuntime } from "@/client-sdk/public-path";
import "@pablozaiden/webapp/web/styles.css";
import { App } from "./App";
import "./webapp-overrides.css";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ToastProvider } from "./components/common/Toast";

function start() {
  configureClientRuntime();
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
