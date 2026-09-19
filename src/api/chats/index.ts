import { defineRoutes } from "@pablozaiden/webapp/server";
import { chatsConversionRoutes } from "./conversion";
import { chatsCrudRoutes } from "./crud";
import { chatsLifecycleRoutes } from "./lifecycle";
import { chatsMessagingRoutes } from "./messaging";
import { chatsTranscriptRoutes } from "./transcripts";

export {
  chatsConversionRoutes,
  chatsCrudRoutes,
  chatsLifecycleRoutes,
  chatsMessagingRoutes,
  chatsTranscriptRoutes,
};

export const chatsRoutes = defineRoutes({
  ...chatsCrudRoutes,
  ...chatsLifecycleRoutes,
  ...chatsMessagingRoutes,
  ...chatsConversionRoutes,
  ...chatsTranscriptRoutes,
});
