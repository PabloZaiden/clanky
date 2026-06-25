import { useEffect, useState } from "react";

export type ResolvedTheme = "light" | "dark";

function getResolvedTheme(): ResolvedTheme {
  if (typeof document === "undefined") {
    return "light";
  }
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function useResolvedTheme(): ResolvedTheme {
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(getResolvedTheme);

  useEffect(() => {
    const root = document.documentElement;
    const update = () => setResolvedTheme(getResolvedTheme());
    update();

    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  return resolvedTheme;
}
