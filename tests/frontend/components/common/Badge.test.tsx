/**
 * Tests for the Badge component.
 */

import { test, expect, describe } from "bun:test";
import {
  getChatStatusBadgeVariant,
  getLoopStatusBadgeVariant,
  getSshSessionStatusBadgeVariant,
  getStatusBadgeVariant,
} from "@/components/common/Badge";

describe("getStatusBadgeVariant", () => {
  test("maps idle to idle", () => {
    expect(getStatusBadgeVariant("idle")).toBe("idle");
  });

  test("maps planning to planning", () => {
    expect(getStatusBadgeVariant("planning")).toBe("planning");
  });

  test("maps starting to running", () => {
    expect(getStatusBadgeVariant("starting")).toBe("running");
  });

  test("maps running to running", () => {
    expect(getStatusBadgeVariant("running")).toBe("running");
  });

  test("maps waiting to running", () => {
    expect(getStatusBadgeVariant("waiting")).toBe("running");
  });

  test("maps completed to completed", () => {
    expect(getStatusBadgeVariant("completed")).toBe("completed");
  });

  test("maps stopped to stopped", () => {
    expect(getStatusBadgeVariant("stopped")).toBe("stopped");
  });

  test("maps max_iterations to stopped", () => {
    expect(getStatusBadgeVariant("max_iterations")).toBe("stopped");
  });

  test("maps failed to failed", () => {
    expect(getStatusBadgeVariant("failed")).toBe("failed");
  });

  test("maps merged to merged", () => {
    expect(getStatusBadgeVariant("merged")).toBe("merged");
  });

  test("maps pushed to pushed", () => {
    expect(getStatusBadgeVariant("pushed")).toBe("pushed");
  });

  test("maps deleted to deleted", () => {
    expect(getStatusBadgeVariant("deleted")).toBe("deleted");
  });

  test("maps unknown status to default", () => {
    expect(getStatusBadgeVariant("unknown")).toBe("default");
    expect(getStatusBadgeVariant("")).toBe("default");
  });
});

describe("getLoopStatusBadgeVariant", () => {
  test("maps plan-ready planning loops to plan_ready", () => {
    expect(getLoopStatusBadgeVariant("planning", true)).toBe("plan_ready");
  });

  test("maps non-ready planning loops to planning", () => {
    expect(getLoopStatusBadgeVariant("planning", false)).toBe("planning");
  });

  test("falls back to the base status mapping for non-planning states", () => {
    expect(getLoopStatusBadgeVariant("running", true)).toBe("running");
  });
});

describe("getChatStatusBadgeVariant", () => {
  test("maps active chat statuses to info or warning variants", () => {
    expect(getChatStatusBadgeVariant("starting")).toBe("info");
    expect(getChatStatusBadgeVariant("streaming")).toBe("info");
    expect(getChatStatusBadgeVariant("reconnecting")).toBe("info");
    expect(getChatStatusBadgeVariant("interrupting")).toBe("warning");
  });

  test("maps idle, stopped, and failed chat statuses to stable variants", () => {
    expect(getChatStatusBadgeVariant("idle")).toBe("success");
    expect(getChatStatusBadgeVariant("stopped")).toBe("stopped");
    expect(getChatStatusBadgeVariant("failed")).toBe("error");
  });
});

describe("getSshSessionStatusBadgeVariant", () => {
  test("maps connected to success", () => {
    expect(getSshSessionStatusBadgeVariant("connected")).toBe("success");
  });

  test("maps connecting to info", () => {
    expect(getSshSessionStatusBadgeVariant("connecting")).toBe("info");
  });

  test("maps failed to error", () => {
    expect(getSshSessionStatusBadgeVariant("failed")).toBe("error");
  });

  test("maps disconnected to warning", () => {
    expect(getSshSessionStatusBadgeVariant("disconnected")).toBe("warning");
  });

  test("maps ready to default", () => {
    expect(getSshSessionStatusBadgeVariant("ready")).toBe("default");
  });
});
