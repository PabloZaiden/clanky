import type { MouseEvent } from "react";
import type { WebAppRoute } from "@pablozaiden/webapp/web";

export type ShellShortcutAction =
  | "new-task"
  | "new-chat"
  | "new-ssh-session"
  | "settings"
  | "code-explorer"
  | "sidebar-search";

interface ShellShortcutDefinition {
  action: ShellShortcutAction;
  key: string;
  labelKey: string;
  route?: WebAppRoute;
}

export const SHELL_SHORTCUTS: Record<ShellShortcutAction, ShellShortcutDefinition> = {
  "new-task": {
    action: "new-task",
    key: "l",
    labelKey: "L",
    route: { view: "compose", kind: "task" },
  },
  "new-chat": {
    action: "new-chat",
    key: "c",
    labelKey: "C",
    route: { view: "compose", kind: "chat" },
  },
  "new-ssh-session": {
    action: "new-ssh-session",
    key: "s",
    labelKey: "S",
    route: { view: "compose", kind: "ssh-session" },
  },
  settings: {
    action: "settings",
    key: ",",
    labelKey: ",",
    route: { view: "settings" },
  },
  "code-explorer": {
    action: "code-explorer",
    key: "e",
    labelKey: "E",
    route: { view: "code-explorer" },
  },
  "sidebar-search": {
    action: "sidebar-search",
    key: "f",
    labelKey: "F",
  },
};

export function getShellShortcutLabel(action: ShellShortcutAction): string {
  return `Ctrl/Cmd+Shift+${SHELL_SHORTCUTS[action].labelKey}`;
}

export function getShellShortcutTitle(action: ShellShortcutAction, title: string): string {
  return `${title} (${getShellShortcutLabel(action)})`;
}

export function getShellShortcutForKeyboardEvent(event: KeyboardEvent): ShellShortcutDefinition | null {
  if (event.defaultPrevented || event.altKey || !event.shiftKey || (!event.metaKey && !event.ctrlKey)) {
    return null;
  }

  const eventKey = event.key.toLowerCase();
  return Object.values(SHELL_SHORTCUTS).find((shortcut) => shortcut.key === eventKey) ?? null;
}

export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return Boolean(target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']"));
}

export function isModifiedNavigationClick(event: MouseEvent<HTMLElement>): boolean {
  return event.metaKey || event.ctrlKey;
}
