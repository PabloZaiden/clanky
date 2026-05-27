import { useEffect, useRef } from "react";
import RFB from "@novnc/novnc";
import type { VncSession } from "../../types";
import { appWebSocketUrl } from "../../lib/public-path";

export function VncViewer({
  session,
  password,
  onDisconnect,
}: {
  session: VncSession;
  password: string;
  onDisconnect: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onDisconnectRef = useRef(onDisconnect);

  useEffect(() => {
    onDisconnectRef.current = onDisconnect;
  }, [onDisconnect]);

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }
    const url = appWebSocketUrl(`/api/vnc?vncSessionId=${encodeURIComponent(session.config.id)}`);
    const rfb = new RFB(containerRef.current, url, {
      credentials: password ? { password } : undefined,
    });
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    const handleDisconnect = () => {
      onDisconnectRef.current();
    };
    rfb.addEventListener("disconnect", handleDisconnect);
    return () => {
      rfb.removeEventListener("disconnect", handleDisconnect);
      rfb.disconnect();
    };
  }, [password, session.config.id]);

  return (
    <div className="overflow-hidden rounded-2xl border border-gray-200 bg-black dark:border-gray-800">
      <div ref={containerRef} className="h-[70vh] min-h-[420px] w-full" />
    </div>
  );
}
