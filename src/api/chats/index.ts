import { defineRoutes } from "@pablozaiden/webapp/server";
import { chatsConversionRoutes } from "./conversion";
import { chatsCrudRoutes } from "./crud";
import { chatsLifecycleRoutes } from "./lifecycle";
import { chatsMessagingRoutes } from "./messaging";
import { chatsTranscriptRoutes } from "./transcripts";
import { chatsActivityRoutes } from "./activity";

export {
  chatsConversionRoutes,
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
  ...chatsConversionRoutes,
  ...chatsTranscriptRoutes,
  ...chatsActivityRoutes,
});
