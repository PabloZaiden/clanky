import type {
  ActionMenuItem,
  SidebarNode,
  WebAppRoute,
} from "@pablozaiden/webapp/web";
import type { Chat } from "@/shared";
import { isChatBusyStatus, isStandaloneChat } from "@/shared/chat";
import type { PrivateEntity } from "../../lib/private-items";
import {
  getPrivateHidden,
  privateActions,
  privateSidebarPresentation,
  sidebarActionItems,
  withPrivateToggleAction,
} from "./shell-sidebar-utils";
import type { SidebarChatNode } from "./shell-types";

export interface ChatSidebarContext {
  route: WebAppRoute;
  selectedChat: Chat | null;
  selectedChatActions: ActionMenuItem[];
  navigateWithinShell: (route: WebAppRoute) => void;
  markChatDone: (chat: Chat) => void | Promise<void>;
  toggleChatPrivate: (chat: Chat) => void | Promise<void>;
  showPrivateItems: boolean;
}

export interface ChatSidebarNodeOptions {
  chatNode: SidebarChatNode;
  ancestors: PrivateEntity[];
  idPrefix: string;
  id?: string;
  pinId?: string;
  subtitle?: string;
  badgeAppearance?: SidebarNode["badgeAppearance"];
  itemLayout?: SidebarNode["itemLayout"];
  render?: SidebarNode["render"];
}

export function getChatSidebarActions(
  chat: Chat,
  context: ChatSidebarContext,
): ActionMenuItem[] {
  const chatId = chat.config.id;
  const markDoneAction = !isStandaloneChat(chat) || chat.state.status === "done"
    ? []
    : [{
        id: "mark-done",
        label: "Mark as Done",
        disabled: isChatBusyStatus(chat.state.status) || chat.state.status === "reconnecting",
        onClick: () => void context.markChatDone(chat),
      }];
  const baseActions = context.route.view === "chat" && context.selectedChat?.config.id === chatId
    ? context.selectedChatActions
    : sidebarActionItems([
        {
          id: "open-code-explorer",
          label: "Open code explorer",
          onClick: () => context.navigateWithinShell({
            view: "code-explorer",
            contentType: "chat",
            chatId,
          }),
        },
        ...markDoneAction,
      ]);
  return withPrivateToggleAction(
    baseActions,
    chat.config,
    () => void context.toggleChatPrivate(chat),
  );
}

export function createChatSidebarNode(
  {
    chatNode,
    ancestors,
    idPrefix,
    id,
    pinId,
    subtitle,
    badgeAppearance,
    itemLayout,
    render,
  }: ChatSidebarNodeOptions,
  context: ChatSidebarContext,
): SidebarNode {
  const privateHidden = getPrivateHidden(chatNode.chat.config, ancestors, context.showPrivateItems);
  const actions = getChatSidebarActions(chatNode.chat, context);
  return privateSidebarPresentation({
    type: "item",
    id: id ?? `${idPrefix}:${chatNode.chat.config.id}`,
    title: chatNode.title,
    subtitle,
    badge: chatNode.badge,
    badgeVariant: chatNode.badgeVariant,
    badgeAppearance,
    itemLayout,
    render,
    route: { view: "chat", chatId: chatNode.chat.config.id },
    actions: privateActions(actions, privateHidden, chatNode.chat.config.isPrivate === true),
    pinnable: true,
    pinId: pinId ?? `${idPrefix}:${chatNode.chat.config.id}`,
  }, privateHidden);
}
