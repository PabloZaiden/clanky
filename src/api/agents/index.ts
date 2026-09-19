/**
 * Scheduled-agent API route aggregation.
 */

import { defineRoutes } from "@pablozaiden/webapp/server";
import { crudRoutes } from "./crud";
import { generationRoutes } from "./generation";
import { runsRoutes, TEST_CODE_HEARTBEAT_INTERVAL_MS } from "./runs";
import { transferRoutes } from "./transfer";
import { transcriptRoutes } from "./transcripts";

export const agentsRoutes = defineRoutes({
  ...crudRoutes,
  ...generationRoutes,
  ...runsRoutes,
  ...transferRoutes,
  ...transcriptRoutes,
});

export { TEST_CODE_HEARTBEAT_INTERVAL_MS };
