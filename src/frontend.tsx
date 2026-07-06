/**
 * This file is the entry point for the React app, it sets up the root
 * element and renders the App component to the DOM.
 *
 * It is included in the framework-owned web document.
 */

import { configureClientRuntime } from "@/client-sdk/public-path";
import { renderWebApp } from "@pablozaiden/webapp/web";
import "@pablozaiden/webapp/web/styles.css";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ToastProvider } from "./components/common/Toast";

function start() {
  configureClientRuntime();
  renderWebApp(
    <ErrorBoundary>
      <ToastProvider>
        <App />
      </ToastProvider>
    </ErrorBoundary>,
  );
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start);
} else {
  start();
}
