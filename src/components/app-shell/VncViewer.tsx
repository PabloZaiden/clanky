import { useEffect, useRef } from "react";
import RFB from "../../vendor/novnc-rfb.js";
import type { VncSession } from "@/shared";
import { appWebSocketUrl } from "../../lib/public-path";

export function VncViewer({
  session,
  username,
  password,
  fullscreen = false,
  onCredentialsRequired,
  onDisconnect,
  onError,
}: {
  session: VncSession;
  username?: string;
  password?: string;
  fullscreen?: boolean;
  onCredentialsRequired?: () => void;
  onDisconnect: () => void;
  onError?: (message: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const credentialsRef = useRef<{ username?: string; password?: string } | undefined>(undefined);
  const onCredentialsRequiredRef = useRef(onCredentialsRequired);
  const onDisconnectRef = useRef(onDisconnect);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    credentialsRef.current = password ? { username, password } : undefined;
  }, [password, username]);

  useEffect(() => {
    onCredentialsRequiredRef.current = onCredentialsRequired;
    onDisconnectRef.current = onDisconnect;
    onErrorRef.current = onError;
  }, [onCredentialsRequired, onDisconnect, onError]);

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }
    const url = appWebSocketUrl(`/api/vnc?vncSessionId=${encodeURIComponent(session.config.id)}`);
    const rfb = new RFB(containerRef.current, url, {
      credentials: credentialsRef.current,
    });
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.qualityLevel = 9;
    rfb.compressionLevel = 0;
    const handleDisconnect = () => {
      onDisconnectRef.current();
    };
    const handleCredentialsRequired = (event: Event) => {
      const detail = (event as Event & { detail?: { types?: string[] } }).detail;
      const requiresUsername = detail?.types?.includes("username") ?? false;
      const credentials = credentialsRef.current;
      if (credentials && (!requiresUsername || credentials.username !== undefined)) {
        rfb.sendCredentials(credentials);
        return;
      }
      onCredentialsRequiredRef.current?.();
    };
    const handleSecurityFailure = (event: Event) => {
      const detail = (event as Event & { detail?: { reason?: string } }).detail;
      onErrorRef.current?.(detail?.reason || "VNC authentication failed.");
    };
    rfb.addEventListener("disconnect", handleDisconnect);
    rfb.addEventListener("credentialsrequired", handleCredentialsRequired);
    rfb.addEventListener("securityfailure", handleSecurityFailure);
    return () => {
      rfb.removeEventListener("disconnect", handleDisconnect);
      rfb.removeEventListener("credentialsrequired", handleCredentialsRequired);
      rfb.removeEventListener("securityfailure", handleSecurityFailure);
      rfb.disconnect();
    };
  }, [session.config.id]);

  return (
    <div className="h-full min-h-0 overflow-hidden rounded-lg border border-gray-200 bg-black dark:border-gray-800">
      <div
        ref={containerRef}
        className={fullscreen ? "h-full min-h-0 w-full" : "h-[70vh] min-h-[420px] w-full"}
      />
    </div>
  );
}
