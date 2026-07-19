/**
 * React Error Boundary component.
 * Catches JavaScript errors in child component tree and displays
 * a fallback UI instead of crashing the entire application.
 *
 * Note: Error boundaries must be class components per React's API.
 */

import { Component, type ReactNode, type ErrorInfo } from "react";
import { createLogger } from "@pablozaiden/webapp/web";

const log = createLogger("ErrorBoundary");

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    log.error("React Error Boundary caught an error", {
      error: String(error),
      componentStack: errorInfo.componentStack,
    });
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  override render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-gray-100 p-8 dark:bg-neutral-950">
          <div className="w-full max-w-lg rounded-lg border border-red-200 bg-white p-6 text-center shadow-sm dark:border-red-800 dark:bg-neutral-900">
            <h1 className="mb-4 text-xl font-semibold text-red-600 dark:text-red-400">
              Something went wrong
            </h1>
            <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
              An unexpected error occurred in the application.
            </p>
            {this.state.error && (
              <pre className="mb-4 max-h-40 overflow-auto rounded border border-red-100 bg-red-50 p-3 text-left text-xs text-red-700 dark:border-gray-800 dark:bg-neutral-950 dark:text-red-300">
                {this.state.error.message}
              </pre>
            )}
            <div className="flex justify-center gap-3">
              <button
                onClick={this.handleReset}
                className="rounded bg-gray-200 px-4 py-2 text-sm text-gray-700 hover:bg-gray-300 dark:bg-neutral-800 dark:text-gray-200 dark:hover:bg-neutral-700"
              >
                Try Again
              </button>
              <button
                onClick={() => window.location.reload()}
                className="rounded bg-blue-700 px-4 py-2 text-sm text-white hover:bg-blue-600"
              >
                Reload Page
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
