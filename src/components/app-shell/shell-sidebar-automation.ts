import type {
  ActionMenuItem,
  SidebarNode,
} from "@pablozaiden/webapp/web";
import type { Automation, Workspace } from "@/shared";
import type { UseAutomationsResult } from "../../hooks/useAutomations";
import { formatStatusLabel } from "../common";
import {
  getPrivateHidden,
  privateActions,
  privateSidebarPresentation,
  sidebarActionItems,
  withPrivateToggleAction,
} from "./shell-sidebar-utils";

export interface AutomationSidebarContext {
  setEditingAutomationId: (automationId: string) => void;
  setDeleteAutomationTarget: (automation: Automation) => void;
  setPurgeAutomationTarget: (automation: Automation) => void;
  exportAutomation: (automation: Automation) => void | Promise<void>;
  automations: Pick<UseAutomationsResult, "pauseAutomation" | "resumeAutomation" | "interruptAutomation" | "runAutomation">;
  onError: (message: string) => void;
  toggleAutomationPrivate: (automation: Automation) => void | Promise<void>;
  showPrivateItems: boolean;
}

export function getAutomationSidebarActions(
  automation: Automation,
  context: AutomationSidebarContext,
): ActionMenuItem[] {
  return withPrivateToggleAction(
    sidebarActionItems([
      {
        id: "edit-automation",
        label: "Edit",
        onClick: () => context.setEditingAutomationId(automation.config.id),
      },
      {
        id: "export-automation",
        label: "Export",
        onClick: () => void context.exportAutomation(automation),
      },
      {
        id: "toggle-automation-paused",
        label: automation.config.enabled ? "Pause" : "Resume",
        onClick: () => {
          const request = automation.config.enabled
            ? context.automations.pauseAutomation(automation.config.id)
            : context.automations.resumeAutomation(automation.config.id);
          void request.then((updated) => {
            if (!updated) {
              context.onError(automation.config.enabled ? "Failed to pause automation" : "Failed to resume automation");
            }
          });
        },
      },
      automation.state.status === "running"
        ? {
            id: "interrupt-automation",
            label: "Interrupt",
            onClick: () => void context.automations.interruptAutomation(automation.config.id),
          }
        : {
            id: "run-automation",
            label: "Run now",
            onClick: () => void context.automations.runAutomation(automation.config.id),
          },
      {
        id: "purge-automation-runs",
        label: "Purge runs",
        destructive: true,
        onClick: () => context.setPurgeAutomationTarget(automation),
      },
      {
        id: "delete-automation",
        label: "Delete",
        destructive: true,
        onClick: () => context.setDeleteAutomationTarget(automation),
      },
    ]),
    automation.config,
    () => void context.toggleAutomationPrivate(automation),
  );
}

export function createAutomationSidebarNode(
  automation: Automation,
  workspace: Workspace,
  context: AutomationSidebarContext,
): SidebarNode {
  const privateHidden = getPrivateHidden(automation.config, [workspace], context.showPrivateItems);
  const actions = getAutomationSidebarActions(automation, context);
  const statusLabel = automation.config.enabled ? "Automation" : "Paused automation";
  return privateSidebarPresentation({
    type: "item",
    id: `automation:${automation.config.id}`,
    title: automation.config.name,
    subtitle: `${workspace.name} · ${statusLabel}`,
    badge: formatStatusLabel(automation.config.enabled ? "enabled" : "paused"),
    badgeVariant: automation.config.enabled ? "success" : "disabled",
    route: { view: "automation", automationId: automation.config.id },
    actions,
    pinnable: true,
    pinId: `automation:${automation.config.id}`,
  }, privateHidden, privateActions(actions, privateHidden, automation.config.isPrivate === true));
}

export function buildAutomationSidebarNodes(
  automations: Automation[],
  workspaces: Workspace[],
  context: AutomationSidebarContext,
): SidebarNode[] {
  const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  return automations.flatMap((automation) => {
    const workspace = workspaceById.get(automation.config.workspaceId);
    return workspace ? [createAutomationSidebarNode(automation, workspace, context)] : [];
  });
}
