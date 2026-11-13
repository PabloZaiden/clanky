import { defineRoutes } from "@/platform/server";
import { chatsCrudRoutes } from "./crud";
import { chatsLifecycleRoutes } from "./lifecycle";
import { chatsMessagingRoutes } from "./messaging";
import { chatsTranscriptRoutes } from "./transcripts";
import { chatsActivityRoutes } from "./activity";
import { chatsDirectoryRoutes } from "./directory";
import { createSubagentRoutes } from "../subagents";

export {
  chatsCrudRoutes,
  chatsLifecycleRoutes,
  chatsMessagingRoutes,
  chatsTranscriptRoutes,
  chatsActivityRoutes,
  chatsDirectoryRoutes,
};

export const chatsRoutes = defineRoutes({
  ...chatsCrudRoutes,
  ...chatsLifecycleRoutes,
  ...chatsMessagingRoutes,
  ...chatsTranscriptRoutes,
  ...chatsActivityRoutes,
  ...chatsDirectoryRoutes,
  ...createSubagentRoutes("chat"),
});
