/**
 * Custom render helper for frontend tests.
 *
 * Wraps @testing-library/react's render with common setup
 * like hash-based routing support and required context providers (ToastProvider).
 */

import { render, type RenderOptions, type RenderResult } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement, type ReactElement, type ReactNode } from "react";
import { ToastProvider } from "@/components/common/Toast";

interface CustomRenderOptions extends Omit<RenderOptions, "wrapper"> {
  /** Set window.location.hash before rendering */
  route?: string;
}

interface CustomRenderResult extends RenderResult {
  /** Pre-configured user-event instance for simulating user interactions */
  user: ReturnType<typeof userEvent.setup>;
}

/**
 * Wrapper component that provides all required context providers for tests.
 * Currently includes ToastProvider (required by Dashboard and components that use useToast).
 */
function AllProviders({ children }: { children: ReactNode }) {
  return createElement(ToastProvider, null, children);
}

/**
 * Custom render function that provides:
 * - Hash route setup via `route` option
 * - Pre-configured userEvent instance
 * - Wraps components in required context providers (ToastProvider)
 *
 * @example
 * ```typescript
 * const { user, getByText } = renderWithUser(<MyComponent />, { route: "#/loop/123" });
 * await user.click(getByText("Submit"));
 * ```
 */
export function renderWithUser(
  ui: ReactElement,
  options?: CustomRenderOptions,
): CustomRenderResult {
  const { route, ...renderOptions } = options ?? {};

  // Set hash route if provided
  if (route) {
    window.location.hash = route;
  }

  const user = userEvent.setup({
    document: globalThis.document,
  });
  const result = render(ui, { wrapper: AllProviders, ...renderOptions });

  return {
    ...result,
    user,
  };
}

/**
 * Lazy screen accessor to avoid the "global document has to be available" error.
 * 
 * `@testing-library/dom`'s `screen` binds to `document.body` at module evaluation time.
 * In Bun, the preload script may not have run before module-level exports are evaluated
 * in subdirectories. This function lazily imports screen at call time, when happy-dom
 * is guaranteed to be registered.
 */
export async function getScreen() {
  const { screen: s } = await import("@testing-library/react");
  return s;
}

// Re-export common testing utilities for convenience
export { render, waitFor, within, act } from "@testing-library/react";
export { default as userEvent } from "@testing-library/user-event";
