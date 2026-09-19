import type {
  ActionMenuItem,
  SidebarNode,
  WebAppRoute,
} from "@pablozaiden/webapp/web";
import type { Task } from "@/shared";
import type { PrivateEntity } from "../../lib/private-items";
import { isTaskActive, isTaskGenerating } from "../../utils";
import {
  getPrivateHidden,
  privateActions,
  privateSidebarPresentation,
  sidebarActionItems,
  withPrivateToggleAction,
} from "./shell-sidebar-utils";

export interface TaskSidebarContext {
  navigateWithinShell: (route: WebAppRoute) => void;
  stopSidebarTask: (task: Task) => void | Promise<void>;
  toggleTaskPrivate: (task: Task) => void | Promise<void>;
  showPrivateItems: boolean;
}

export interface TaskSidebarNodeOptions {
  task: Task;
  id: string;
  title: string;
  badge: string;
  badgeVariant: SidebarNode["badgeVariant"];
  ancestors: PrivateEntity[];
  pinId: string;
  subtitle?: string;
  badgeAppearance?: SidebarNode["badgeAppearance"];
  itemLayout?: SidebarNode["itemLayout"];
  render?: SidebarNode["render"];
}

export function getTaskSidebarActions(
  task: Task,
  context: TaskSidebarContext,
): ActionMenuItem[] {
  const stopAction = isTaskGenerating(task)
    && (isTaskActive(task.state.status) || task.state.status === "planning")
    ? [{
        id: "stop-task",
        label: "Stop task",
        destructive: true,
        onClick: () => void context.stopSidebarTask(task),
      }]
    : [];
  return withPrivateToggleAction(
    sidebarActionItems([
      {
        id: "open-code-explorer",
        label: "Open code explorer",
        onClick: () => context.navigateWithinShell({
          view: "code-explorer",
          contentType: "task",
          taskId: task.config.id,
        }),
      },
      ...stopAction,
    ]),
    task.config,
    () => void context.toggleTaskPrivate(task),
  );
}

export function createTaskSidebarNode(
  {
    task,
    id,
    title,
    badge,
    badgeVariant,
    ancestors,
    pinId,
    subtitle,
    badgeAppearance,
    itemLayout,
    render,
  }: TaskSidebarNodeOptions,
  context: TaskSidebarContext,
): SidebarNode {
  const privateHidden = getPrivateHidden(task.config, ancestors, context.showPrivateItems);
  const actions = getTaskSidebarActions(task, context);
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
    route: { view: "task", taskId: task.config.id },
    actions: privateActions(actions, privateHidden, task.config.isPrivate === true),
    pinnable: true,
    pinId,
  }, privateHidden);
}
