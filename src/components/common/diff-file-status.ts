import type { FileDiff } from "../../types";

export function getDiffFileStatusPresentation(status: FileDiff["status"]): { symbol: string; className: string } {
  switch (status) {
    case "added":
      return { symbol: "+", className: "text-green-600 dark:text-green-400" };
    case "deleted":
      return { symbol: "-", className: "text-red-600 dark:text-red-400" };
    case "renamed":
      return { symbol: "→", className: "text-gray-600 dark:text-gray-300" };
    case "modified":
      return { symbol: "~", className: "text-yellow-600 dark:text-yellow-400" };
  }
}
