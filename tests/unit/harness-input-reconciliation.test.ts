import { expect, test } from "bun:test";
import type { HarnessInputAdmission } from "../../src/shared/harness-control";
import { preserveDeliveredHarnessInputAdmission } from "../../src/components/harness-input-reconciliation";

test("a late admission check cannot undo confirmed delivery", () => {
  // Lifecycle invariant not covered by API tests: stale check results must not regress a delivered receipt.
  const delivered: HarnessInputAdmission = {
    status: "delivered",
    inputId: "input-1",
    nativeMessageId: "native-1",
  };
  const staleAccepted: HarnessInputAdmission = {
    status: "accepted",
    inputId: "input-1",
    nativeMessageId: "native-1",
  };
  const staleUnknown: HarnessInputAdmission = {
    status: "unknown",
    inputId: "input-1",
  };

  expect(preserveDeliveredHarnessInputAdmission(delivered, staleAccepted)).toEqual(delivered);
  expect(preserveDeliveredHarnessInputAdmission(delivered, staleUnknown)).toEqual(delivered);
});
