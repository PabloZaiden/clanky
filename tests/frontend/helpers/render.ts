/**
 * Custom render helper for frontend tests.
 *
 * Wraps @testing-library/react's render with common setup
 * like canonical framework route setup.
 */

import { render, type RenderOptions, type RenderResult } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { replaceWebAppRoute, type WebAppRoute } from "@pablozaiden/webapp/web";

interface CustomRenderOptions extends Omit<RenderOptions, "wrapper"> {
  /** Set the framework route before rendering */
  route?: WebAppRoute;
}

interface CustomRenderResult extends RenderResult {
  /** Pre-configured user-event instance for simulating user interactions */
  user: ReturnType<typeof userEvent.setup>;
}

/**
 * Custom render function that provides:
 * - Framework route setup via the `route` option
 * - Pre-configured userEvent instance
 *
 * @example
 * ```typescript
 * const { user, getByText } = renderWithUser(<MyComponent />, {
 *   route: { view: "task", taskId: "123" },
 * });
 * await user.click(getByText("Submit"));
 * ```
 */
export function renderWithUser(
  ui: ReactElement,
  options?: CustomRenderOptions,
): CustomRenderResult {
  const { route, ...renderOptions } = options ?? {};

  // Set the route through the same framework helper used by the application.
  if (route) {
    replaceWebAppRoute(route);
  }

  const user = userEvent.setup({
    document: globalThis.document,
  });
  const result = render(ui, renderOptions);

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
