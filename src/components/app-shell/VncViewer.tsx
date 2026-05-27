import { useEffect, useRef } from "react";
import RFB from "@novnc/novnc";
import type { VncSession } from "../../types";
import { appWebSocketUrl } from "../../lib/public-path";

export function VncViewer({
  session,
  username,
  password,
  fullscreen = false,
  onDisconnect,
  onError,
}: {
  session: VncSession;
  username?: string;
  password: string;
  fullscreen?: boolean;
  onDisconnect: () => void;
  onError?: (message: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onDisconnectRef = useRef(onDisconnect);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onDisconnectRef.current = onDisconnect;
    onErrorRef.current = onError;
  }, [onDisconnect, onError]);

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }
    const url = appWebSocketUrl(`/api/vnc?vncSessionId=${encodeURIComponent(session.config.id)}`);
    const credentials = password || username ? { username: username || undefined, password: password || undefined } : undefined;
    const rfb = new RFB(containerRef.current, url, {
      credentials,
    });
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.qualityLevel = 9;
    rfb.compressionLevel = 0;
    const handleDisconnect = () => {
      onDisconnectRef.current();
    };
    const handleCredentialsRequired = () => {
      rfb.sendCredentials(credentials ?? {});
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
  }, [password, session.config.id, username]);

  return (
    <div className="h-full min-h-0 overflow-hidden rounded-lg border border-gray-200 bg-black dark:border-gray-800">
      <svg aria-hidden="true" className="absolute h-0 w-0">
        <filter id="clanky-vnc-swap-red-blue">
          <feColorMatrix
            type="matrix"
            values="0 0 1 0 0  0 1 0 0 0  1 0 0 0 0  0 0 0 1 0"
          />
        </filter>
      </svg>
      <div
        ref={containerRef}
        className={fullscreen ? "h-full min-h-0 w-full" : "h-[70vh] min-h-[420px] w-full"}
        style={{ filter: "url(#clanky-vnc-swap-red-blue)" }}
      />
    </div>
  );
}
