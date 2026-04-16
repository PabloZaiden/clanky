import { useEffect, useMemo, useState } from "react";
import { createLogger } from "../../lib/logger";
import {
  type ShellRoute,
  isDesktopShellViewport,
  loadSidebarSectionCollapseState,
  saveSidebarSectionCollapseState,
} from "./shell-types";

const log = createLogger("AppShell");

export interface UseSidebarResult {
  sidebarOpen: boolean;
  sidebarCollapsed: boolean;
  shellHeaderOffsetClassName: string;
  navigateWithinShell: (route: ShellRoute) => void;
  openSidebar: () => void;
  hideSidebar: () => void;
  isNodeCollapsed: (collapseKey: string) => boolean;
  toggleNodeCollapsed: (collapseKey: string) => void;
}

export function useSidebar(_route: ShellRoute, onNavigate: (route: ShellRoute) => void): UseSidebarResult {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const initialSidebarSectionState = useMemo(() => loadSidebarSectionCollapseState(), []);
  const [collapsedNodes, setCollapsedNodes] = useState<Record<string, boolean>>(initialSidebarSectionState.state);

  const shellHeaderOffsetClassName = sidebarCollapsed
    ? "ml-14 sm:ml-16 lg:ml-[4.5rem]"
    : "ml-14 sm:ml-16 lg:ml-0";

  useEffect(() => {
    if (!initialSidebarSectionState.invalidReason) {
      return;
    }
    log.warn("Removing invalid sidebar section state", { error: initialSidebarSectionState.invalidReason });
  }, [initialSidebarSectionState.invalidReason]);

  useEffect(() => {
    saveSidebarSectionCollapseState(collapsedNodes);
  }, [collapsedNodes]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const mediaQuery = window.matchMedia("(min-width: 1024px)");
    const handleChange = (event: MediaQueryListEvent) => {
      if (event.matches) {
        setSidebarOpen(false);
      }
    };

    if (mediaQuery.matches) {
      setSidebarOpen(false);
    }

    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  const navigateWithinShell = (nextRoute: ShellRoute) => {
    setSidebarOpen(false);
    onNavigate(nextRoute);
  };

  const openSidebar = () => {
    if (isDesktopShellViewport()) {
      setSidebarCollapsed(false);
      return;
    }
    setSidebarOpen(true);
  };

  const hideSidebar = () => {
    if (isDesktopShellViewport()) {
      setSidebarCollapsed(true);
      return;
    }
    setSidebarOpen(false);
  };

  function isNodeCollapsed(collapseKey: string): boolean {
    return collapsedNodes[collapseKey] ?? false;
  }

  function toggleNodeCollapsed(collapseKey: string) {
    setCollapsedNodes((current) => {
      const nextCollapsed = !(current[collapseKey] ?? false);

      if (!nextCollapsed) {
        const { [collapseKey]: _removed, ...remaining } = current;
        return remaining;
      }

      return {
        ...current,
        [collapseKey]: true,
      };
    });
  }

  // Suppress unused warning — route may be used in the future for route-aware sidebar behavior.
  return {
    sidebarOpen,
    sidebarCollapsed,
    shellHeaderOffsetClassName,
    navigateWithinShell,
    openSidebar,
    hideSidebar,
    isNodeCollapsed,
    toggleNodeCollapsed,
  };
}
