import { RealtimeResyncRequiredError, useRealtime, useVersionedRealtime, type ResourceRealtimeEvent } from "@pablozaiden/webapp/web";
import type { ProvisioningEvent, PublicProvisioningJobSnapshot } from "@/shared";
import { readApiResponse, requestApiResponse } from "../lib/api-client";

type ProvisioningStreamEvent = Extract<
  ProvisioningEvent,
  { type: "provisioning.step" | "provisioning.output" }
>;

export function useProvisioningSnapshot(
  jobId: string | null,
  initialSnapshot: PublicProvisioningJobSnapshot | null,
) {
  const query = useVersionedRealtime<PublicProvisioningJobSnapshot | null, ProvisioningStreamEvent>({
    deps: [jobId],
    enabled: jobId !== null,
    targets: { provisioningJobId: jobId ?? undefined },
    types: ["provisioning.step", "provisioning.output"],
    trackLastEvent: false,
    load: async ({ signal }) => {
      const response = await requestApiResponse(`/api/provisioning-jobs/${encodeURIComponent(jobId!)}`, {
        signal,
        action: "Load provisioning job",
        fallbackMessage: "Failed to load provisioning job",
        acceptedStatuses: [404],
      });
      if (response.status === 404) return { epoch: `deleted:${jobId}`, revision: 0, data: null };
      const data = await readApiResponse<PublicProvisioningJobSnapshot>(response);
      return { ...data.position, data };
    },
    version: (event) => event.streamPosition,
    reduce: (data, event) => {
      if (!data) throw new RealtimeResyncRequiredError("Provisioning output arrived without its job baseline");
      return event.type === "provisioning.output"
        ? { ...data, position: event.streamPosition, logs: [...data.logs, event.entry].slice(-2000) }
        : { ...data, position: event.streamPosition, job: event.job };
    },
  });
  useRealtime<ResourceRealtimeEvent>({
    enabled: jobId !== null,
    resources: ["provisioning-jobs"],
    ids: jobId ? [jobId] : [],
    trackLastEvent: false,
    onEvent: () => { void query.refresh(); },
  });
  const current = query.data === undefined ? initialSnapshot : query.data;
  const snapshot = current?.job.config.id === jobId ? current : null;
  return {
    snapshot,
    refreshJob: query.refresh,
    loading: query.status === "loading" && snapshot === null,
    notFound: jobId !== null && query.data === null,
    error: query.error,
    websocketStatus: query.realtimeStatus,
  };
}
