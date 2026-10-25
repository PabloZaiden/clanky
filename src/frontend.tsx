/**
 * This file is the entry point for the React app, it sets up the root
 * element and renders the App component to the DOM.
 *
 * It is included in the framework-owned web document.
 */

import { initializeClankyClient } from "@/client-sdk/browser-runtime";
import { ErrorState, renderWebApp } from "@pablozaiden/webapp/web";
import "@pablozaiden/webapp/web/styles.css";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";

async function start(): Promise<void> {
  try {
    await initializeClankyClient();
  } catch (error) {
    console.error("Clanky could not initialize", String(error));
    renderWebApp(<ErrorState title="Unable to start Clanky" description={error instanceof Error ? error.message : String(error)} />);
    return;
  }
  renderWebApp(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>,
  );
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void start(), { once: true });
} else {
  void start();
}
