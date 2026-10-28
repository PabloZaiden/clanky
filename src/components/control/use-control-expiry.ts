import { useEffect, useState } from "react";

export function useControlExpiry(expiresAt: number | undefined): boolean {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (expiresAt === undefined) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [expiresAt]);
  return expiresAt !== undefined && expiresAt <= Math.max(now, Date.now());
}
