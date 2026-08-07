import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import {
  replaceWebAppRoute,
  type WebAppRootController,
  type WebAppRoute,
} from "@pablozaiden/webapp/web";
import { getShellShortcutForKeyboardEvent, isEditableShortcutTarget } from "./shell-shortcuts";

export const HOME_ROUTE: WebAppRoute = { view: "home" };

interface UseShellNavigationOptions {
  setRoute: Dispatch<SetStateAction<WebAppRoute>>;
}

export function useShellNavigation({
  setRoute,
}: UseShellNavigationOptions) {
  const webAppRootRef = useRef<WebAppRootController>(null);
  const handleWebRouteChange = useCallback((nextRoute: WebAppRoute) => setRoute(nextRoute), [setRoute]);
  const navigateWithinShell = useCallback((nextRoute: WebAppRoute) => {
    replaceWebAppRoute(nextRoute);
  }, []);
  const focusSidebarSearch = useCallback(() => {
    webAppRootRef.current?.sidebar.focusSearch();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const shortcut = getShellShortcutForKeyboardEvent(event);
      if (!shortcut || isEditableShortcutTarget(event.target)) {
        return;
      }

      event.preventDefault();
      if (shortcut.action === "sidebar-search") {
        focusSidebarSearch();
        return;
      }
      if (shortcut.route) {
        navigateWithinShell(shortcut.route);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [focusSidebarSearch, navigateWithinShell]);

  return {
    webAppRootRef,
    handleWebRouteChange,
    navigateWithinShell,
  };
}
