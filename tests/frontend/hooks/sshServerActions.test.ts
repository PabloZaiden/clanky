import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createMockApi } from "../helpers/mock-api";
import {
  createStandaloneSshSessionApi,
  deleteStandaloneSshSessionApi,
} from "@/hooks/sshServerActions";

const api = createMockApi();

beforeEach(() => {
  api.reset();
  api.install();
});

afterEach(() => {
  api.uninstall();
});

describe("createStandaloneSshSessionApi", () => {
  test("trims the name and forwards the requested connection mode and tmux preference", async () => {
    api.post("/api/ssh-servers/:id/sessions", (req) => {
      expect(req.params["id"]).toBe("server-1");
      expect(req.body).toEqual({
        name: "Deploy shell",
        credentialToken: null,
        connectionMode: "direct",
        useTmux: false,
      });
      return {
        config: {
          id: "session-1",
          sshServerId: "server-1",
          name: "Deploy shell",
          connectionMode: "direct",
          useTmux: false,
          remoteSessionName: "clanky-standalone-1",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        state: {
          status: "ready",
        },
      };
    });

    const session = await createStandaloneSshSessionApi({
      serverId: "server-1",
      name: "  Deploy shell  ",
      connectionMode: "direct",
      useTmux: false,
    });

    expect(session.config.connectionMode).toBe("direct");
    expect(session.config.useTmux).toBe(false);
    expect(api.calls("/api/ssh-servers/:id/sessions", "POST")).toHaveLength(1);
  });
});

describe("deleteStandaloneSshSessionApi", () => {
  test("omits the JSON body when deleting a direct standalone session", async () => {
    api.delete("/api/ssh-server-sessions/:id", (req) => {
      expect(req.params["id"]).toBe("session-1");
      expect(req.body).toEqual({ credentialToken: null });
      return { success: true };
    });

    const deleted = await deleteStandaloneSshSessionApi({
      sessionId: "session-1",
      serverId: "server-1",
      requireCredential: false,
    });

    expect(deleted).toBe(true);
    expect(api.calls("/api/ssh-server-sessions/:id", "DELETE")).toHaveLength(1);
    expect(api.calls("/api/ssh-server-sessions/:id", "DELETE")[0]?.body).toEqual({ credentialToken: null });
  });
});
