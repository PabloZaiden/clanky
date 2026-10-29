import { defineRoutes } from "@pablozaiden/webapp/server";
import { chatsCrudRoutes } from "./crud";
import { chatsLifecycleRoutes } from "./lifecycle";
import { chatsMessagingRoutes } from "./messaging";
import { chatsTranscriptRoutes } from "./transcripts";
import { chatsActivityRoutes } from "./activity";
import { createSubagentRoutes } from "../subagents";

export {
  chatsCrudRoutes,
  chatsLifecycleRoutes,
  chatsMessagingRoutes,
  chatsTranscriptRoutes,
  chatsActivityRoutes,
};

export const chatsRoutes = defineRoutes({
  ...chatsCrudRoutes,
  ...chatsLifecycleRoutes,
  ...chatsMessagingRoutes,
  ...chatsTranscriptRoutes,
  ...chatsActivityRoutes,
  ...createSubagentRoutes("chat"),
});
