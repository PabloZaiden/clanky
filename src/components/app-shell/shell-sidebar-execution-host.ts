import type {
  ActionMenuItem,
  WebAppRoute,
} from "@pablozaiden/webapp/web";
import type { ExecutionHostDescriptor } from "@/shared";
import {
  getExecutionHostDefaultDirectory,
  getExecutionHostSourceId,
  supportsExecutionHostCapability,
} from "@/shared";
import { sidebarActionItems } from "./shell-sidebar-utils";
import { getClankyClientCapabilities } from "../../client-sdk/capabilities";

export interface ExecutionHostSidebarContext {
  navigateWithinShell: (route: WebAppRoute) => void;
}

export function executionHostId(host: ExecutionHostDescriptor): string {
  return getExecutionHostSourceId(host.ref);
}

export function executionHostDirectory(host: ExecutionHostDescriptor): string {
  return getExecutionHostDefaultDirectory(host);
}

export function executionHostUsable(host: ExecutionHostDescriptor): boolean {
  return host.acceptRemoteExecution;
}

export function getExecutionHostWorkspaceRoute(host: ExecutionHostDescriptor): WebAppRoute {
  return {
    view: "compose",
    kind: "workspace",
    workspaceMode: "automatic",
    executionHostKind: host.ref.kind,
    executionHostId: executionHostId(host),
    basePath: executionHostDirectory(host),
  };
}

export function getExecutionHostChatRoute(host: ExecutionHostDescriptor): WebAppRoute {
  return {
    view: "compose",
    kind: "execution-host-chat",
    hostKind: host.ref.kind,
    hostId: executionHostId(host),
  };
}

export function getExecutionHostTerminalRoute(host: ExecutionHostDescriptor): WebAppRoute {
  return {
    view: "compose",
    kind: "execution-host-terminal",
    hostKind: host.ref.kind,
    hostId: executionHostId(host),
  };
}

export function createExecutionHostWorkspace(
  host: ExecutionHostDescriptor,
  context: ExecutionHostSidebarContext,
): void {
  context.navigateWithinShell(getExecutionHostWorkspaceRoute(host));
}

export function createExecutionHostChat(
  host: ExecutionHostDescriptor,
  context: ExecutionHostSidebarContext,
): void {
  context.navigateWithinShell(getExecutionHostChatRoute(host));
}

export function createExecutionHostTerminal(
  host: ExecutionHostDescriptor,
  context: ExecutionHostSidebarContext,
): void {
  context.navigateWithinShell(getExecutionHostTerminalRoute(host));
}

export function getExecutionHostSidebarActions(
  host: ExecutionHostDescriptor,
  context: ExecutionHostSidebarContext,
): ActionMenuItem[] {
  const usable = executionHostUsable(host);
  return sidebarActionItems([
    {
      id: "new-workspace",
      label: "New Workspace",
      disabled: !usable || !host.capabilities.provisioning,
      onClick: () => createExecutionHostWorkspace(host, context),
    },
    {
      id: "new-terminal",
      label: "New Terminal",
      disabled: !usable || !host.capabilities.interactiveTerminal || !getClankyClientCapabilities().terminalManagement,
      onClick: () => createExecutionHostTerminal(host, context),
    },
    {
      id: "new-chat",
      label: "New Chat",
      disabled: !usable || !host.capabilities.acpRuntime,
      onClick: () => createExecutionHostChat(host, context),
    },
    {
      id: "open-code-explorer",
      label: "Code Explorer",
      disabled: !usable || !supportsExecutionHostCapability(host.capabilities, "fileOperations"),
      onClick: () => context.navigateWithinShell({
        view: "code-explorer",
        contentType: "execution-host",
        hostKind: host.ref.kind,
        hostId: executionHostId(host),
      }),
    },
  ]);
}
