import { useLiveQuery } from "@pablozaiden/webapp/web";
import type { ControlRequestSummary } from "@/contracts/schemas/control";
import { apiRequest } from "../../lib/api-client";
import { getClankyClientCapabilities } from "../../client-sdk/capabilities";
import { useControlExpiry } from "./use-control-expiry";

export function usePendingControlRequests() {
  const query = useLiveQuery({
    enabled: getClankyClientCapabilities().controllerAdministration,
    load: (signal) => apiRequest<ControlRequestSummary[]>("/api/control/requests", { signal }),
    realtime: { resources: ["control-requests"] },
  });
  const requests = query.data?.filter((request) => request.status === "pending" && request.expiresAt > Date.now());
  const nextExpiry = requests?.reduce<number | undefined>(
    (earliest, request) => Math.min(earliest ?? request.expiresAt, request.expiresAt), undefined,
  );
  // Re-render at each deadline even while realtime is disconnected.
  useControlExpiry(nextExpiry);
  return { ...query, data: requests };
}
