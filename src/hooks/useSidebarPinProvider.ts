import { useMemo } from "react";
import { useRealtimeRefresh, useWebAppRuntime, type SidebarPinProvider } from "@pablozaiden/webapp/web";
import { SidebarPinsResponseSchema } from "@/contracts/schemas/sidebar-pins";
import { CLANKY_REALTIME_RESOURCES } from "@/shared/realtime";
import { apiRequest } from "@/lib/api-client";
import { isBrowserCollaborationClient } from "@/client-sdk/browser-runtime";

const PATH = "/api/preferences/sidebar-pins";

export function useSidebarPinProvider(): SidebarPinProvider | undefined {
  const runtime = useWebAppRuntime();
  const accountBacked = !isBrowserCollaborationClient();
  const source = useMemo(() => {
    const listeners = new Set<() => void>();
    const provider: SidebarPinProvider = {
      async load(signal) {
        const response = await apiRequest<unknown>(PATH, { signal, action: "Load sidebar pins" });
        return SidebarPinsResponseSchema.parse(response).pins;
      },
      async add(pin, signal) {
        SidebarPinsResponseSchema.parse(await apiRequest<unknown>(PATH, {
          method: "PUT", signal, body: JSON.stringify({ pin }),
          headers: { "Content-Type": "application/json" }, action: "Pin sidebar item",
        }));
      },
      async remove(id, signal) {
        SidebarPinsResponseSchema.parse(await apiRequest<unknown>(PATH, {
          method: "DELETE", signal, body: JSON.stringify({ id }),
          headers: { "Content-Type": "application/json" }, action: "Unpin sidebar item",
        }));
      },
      subscribe(invalidate) {
        listeners.add(invalidate);
        return () => { listeners.delete(invalidate); };
      },
    };
    return {
      provider,
      invalidate: () => { for (const listener of listeners) listener(); },
    };
  }, [runtime.scope, runtime.generation]);

  useRealtimeRefresh({
    enabled: accountBacked,
    resources: [CLANKY_REALTIME_RESOURCES.sidebarPins],
    refresh: source.invalidate,
    deps: [source],
  });
  return accountBacked ? source.provider : undefined;
}
