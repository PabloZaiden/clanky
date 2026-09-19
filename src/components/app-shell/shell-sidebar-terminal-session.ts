import type {
  ActionMenuItem,
  SidebarNode,
} from "@pablozaiden/webapp/web";
import type { TerminalSession } from "@/shared";
import type { PrivateEntity } from "../../lib/private-items";
import {
  getPrivateHidden,
  privateActions,
  privateSidebarPresentation,
  sidebarActionItems,
  withPrivateToggleAction,
} from "./shell-sidebar-utils";
import type { TerminalSessionActionTarget } from "./shell-sidebar-types";

export interface TerminalSessionSidebarContext {
  toggleTerminalSessionPrivate: (session: TerminalSession) => void | Promise<void>;
  openRenameTerminalSession: (target: TerminalSessionActionTarget) => void;
  openDeleteTerminalSession: (target: TerminalSessionActionTarget) => void;
  showPrivateItems: boolean;
}

export interface TerminalSessionSidebarNodeOptions {
  session: TerminalSession;
  target: TerminalSessionActionTarget;
  id: string;
  title: string;
  ancestors: Array<PrivateEntity | null | undefined>;
  pinId: string;
  subtitle?: string;
  badge?: string;
  badgeVariant?: SidebarNode["badgeVariant"];
  badgeAppearance?: SidebarNode["badgeAppearance"];
  itemLayout?: SidebarNode["itemLayout"];
  render?: SidebarNode["render"];
}

export function getTerminalSessionSidebarActions(
  target: TerminalSessionActionTarget,
  session: TerminalSession,
  context: TerminalSessionSidebarContext,
): ActionMenuItem[] {
  const baseActions = sidebarActionItems([
    {
      id: "rename-terminal-session",
      label: "Rename",
      onClick: () => context.openRenameTerminalSession(target),
    },
    {
      id: "delete-terminal-session",
      label: "Delete Session",
      destructive: true,
      onClick: () => context.openDeleteTerminalSession(target),
    },
  ]);
  return withPrivateToggleAction(baseActions, session.config, () => {
    void context.toggleTerminalSessionPrivate(session);
  });
}

export function createTerminalSessionSidebarNode(
  {
    session,
    target,
    id,
    title,
    ancestors,
    pinId,
    subtitle,
    badge,
    badgeVariant,
    badgeAppearance,
    itemLayout,
    render,
  }: TerminalSessionSidebarNodeOptions,
  context: TerminalSessionSidebarContext,
): SidebarNode {
  const privateHidden = getPrivateHidden(session.config, ancestors, context.showPrivateItems);
  const actions = getTerminalSessionSidebarActions(target, session, context);
  return privateSidebarPresentation({
    type: "item",
    id,
    title,
    subtitle,
    badge,
    badgeVariant,
    badgeAppearance,
    itemLayout,
    render,
    route: { view: "terminal", terminalSessionId: session.config.id },
    actions: privateActions(actions, privateHidden, session.config.isPrivate === true),
    pinnable: true,
    pinId,
  }, privateHidden);
}
