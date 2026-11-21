import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import {
  replaceWebAppRoute,
  routeToHash,
  type WebAppRootController,
  type WebAppRoute,
} from "@pablozaiden/webapp/web";
import { getShellShortcutForKeyboardEvent, isEditableShortcutTarget } from "./shell-shortcuts";
import { getClankyRouteUnavailableReason } from "../../client-sdk/capabilities";
import { isPerformanceCaptureEnabled, notePerformanceChatNavigation } from "@/platform/web/performance-stats";
import { getRouteString } from "./route-fields";

export const HOME_ROUTE: WebAppRoute = { view: "home" };

declare global {
  interface Window {
    clankyOpenSettings?: () => void;
  }
}

interface UseShellNavigationOptions {
  setRoute: Dispatch<SetStateAction<WebAppRoute>>;
}

export function useShellNavigation({
  setRoute,
}: UseShellNavigationOptions) {
  const webAppRootRef = useRef<WebAppRootController>(null);
  const currentChatId = useRef<string | undefined>(undefined);
  const navigation = useRef<{ hash: string; start: number } | undefined>(undefined);
  const handleWebRouteChange = useCallback((nextRoute: WebAppRoute) => {
    const chatId = nextRoute.view === "chat" ? getRouteString(nextRoute, "chatId") : undefined;
    if (chatId !== currentChatId.current) {
      const opening = navigation.current;
      const matches = opening && opening.hash === routeToHash(nextRoute);
      if (matches) navigation.current = undefined;
      notePerformanceChatNavigation(chatId, matches ? opening : undefined);
      currentChatId.current = chatId;
    }
    setRoute(nextRoute);
  }, [setRoute]);
  const navigateWithinShell = useCallback((nextRoute: WebAppRoute) => {
    replaceWebAppRoute(nextRoute);
  }, []);
  const focusSidebarSearch = useCallback(() => {
    webAppRootRef.current?.sidebar.focusSearch();
  }, []);

  useEffect(() => {
    // Webapp emits this synchronously for in-app navigation, before committing its route.
    const trackNavigation = (event: HashChangeEvent) => {
      navigation.current = isPerformanceCaptureEnabled()
        ? { hash: new URL(event.newURL).hash, start: event.timeStamp }
        : undefined;
    };
    window.addEventListener("hashchange", trackNavigation, true);
    return () => window.removeEventListener("hashchange", trackNavigation, true);
  }, []);

  useEffect(() => {
    const openSettings = () => navigateWithinShell({ view: "settings" });
    window.clankyOpenSettings = openSettings;
    return () => {
      if (window.clankyOpenSettings === openSettings) delete window.clankyOpenSettings;
    };
  }, [navigateWithinShell]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const shortcut = getShellShortcutForKeyboardEvent(event);
      if (!shortcut || isEditableShortcutTarget(event.target)) {
        return;
      }

      event.preventDefault();
      if (shortcut.route && getClankyRouteUnavailableReason(shortcut.route)) return;
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
