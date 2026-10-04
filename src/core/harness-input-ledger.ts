/**
 * Retains unresolved admissions; only settled receipts may be evicted.
 */

import type { HarnessInputReceipt } from "@/shared/harness-control";
import { HarnessError } from "../backends/harness-errors";

export function retainHarnessInputReceipt(receipts: readonly HarnessInputReceipt[], receipt: HarnessInputReceipt): HarnessInputReceipt[] {
  const previous = receipts.filter((entry) => entry.admission.inputId !== receipt.admission.inputId);
  const unresolved = previous.filter((entry) => entry.admission.status === "unknown");
  const settled = previous.filter((entry) => entry.admission.status !== "unknown").slice(-199);
  if (unresolved.length >= 800) throw new HarnessError("harness_input_capacity", "Unresolved input admission capacity reached.");
  return [...unresolved, ...settled, receipt];
}
