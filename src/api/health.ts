/**
 * Health check API endpoint for Clanky Tasks Management System.
 * 
 * Provides a simple health check endpoint to verify the server is running.
 * Used by load balancers, monitoring tools, and the UI to check connectivity.
 * 
 * Endpoint:
 * - GET /api/health - Returns health status and version
 * 
 * @module api/health
 */

import type { HealthResponse } from "../types/api";
import { createLogger } from "../core/logger";
import { CLANKY_VERSION } from "../version";

const log = createLogger("api:health");

/**
 * Health check route handler.
 * 
 * Provides a single endpoint for health checks:
 * - GET /api/health - Returns { healthy: true, version: "x.x.x" }
 */
export const healthRoutes = {
  "/api/health": {
    /**
     * GET /api/health - Check if the server is running.
     * 
     * Returns a simple health response with the current version.
     * Always returns healthy: true when the server is responding.
     * 
     * @returns HealthResponse with healthy flag and version
     */
    async GET(): Promise<Response> {
      log.trace("GET /api/health");
      const response: HealthResponse = {
        healthy: true,
        version: CLANKY_VERSION,
      };
      return Response.json(response);
    },
  },
};
