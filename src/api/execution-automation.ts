import type { RouteAutomationMetadata } from "@pablozaiden/webapp/server";

export function executionAutomation(
  policy: "read" | "write" | "confirm", reason: string,
  options: Omit<NonNullable<RouteAutomationMetadata["execution"]>, "policy"> = {},
): RouteAutomationMetadata {
  return { policy: "excluded", reason, execution: {
    policy, ...(options.privateResponse ? { responseFormat: "file" as const } : {}), ...options,
  } };
}
