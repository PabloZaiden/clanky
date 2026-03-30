/**
 * Tests for the Badge component.
 */

import { test, expect, describe } from "bun:test";
import {
  Badge,
  getChatStatusBadgeVariant,
  getLoopStatusBadgeVariant,
  getSshSessionStatusBadgeVariant,
  getStatusBadgeVariant,
} from "@/components/common/Badge";
import { renderWithUser } from "../../helpers/render";

describe("Badge", () => {
  describe("rendering", () => {
    test("renders children text", () => {
      const { getByText } = renderWithUser(<Badge>Active</Badge>);
      expect(getByText("Active")).toBeInTheDocument();
    });

    test("renders as a span element", () => {
      const { getByText } = renderWithUser(<Badge>Test</Badge>);
      const badge = getByText("Test");
      expect(badge.tagName).toBe("SPAN");
    });
  });

  describe("default variant", () => {
    test("applies default variant classes", () => {
      const { getByText } = renderWithUser(<Badge>Default</Badge>);
      const badge = getByText("Default");
      expect(badge.className).toContain("bg-gray-100");
    });
  });

  describe("generic variants", () => {
    test("applies success variant classes", () => {
      const { getByText } = renderWithUser(<Badge variant="success">Success</Badge>);
      const badge = getByText("Success");
      expect(badge.className).toContain("bg-green-100");
    });

    test("applies warning variant classes", () => {
      const { getByText } = renderWithUser(<Badge variant="warning">Warning</Badge>);
      const badge = getByText("Warning");
      expect(badge.className).toContain("bg-yellow-100");
    });

    test("applies error variant classes", () => {
      const { getByText } = renderWithUser(<Badge variant="error">Error</Badge>);
      const badge = getByText("Error");
      expect(badge.className).toContain("bg-red-100");
    });

    test("applies info variant classes", () => {
      const { getByText } = renderWithUser(<Badge variant="info">Info</Badge>);
      const badge = getByText("Info");
      expect(badge.className).toContain("bg-blue-100");
    });
  });

  describe("loop status variants", () => {
    test("applies idle variant classes", () => {
      const { getByText } = renderWithUser(<Badge variant="idle">Idle</Badge>);
      const badge = getByText("Idle");
      expect(badge.className).toContain("bg-gray-100");
    });

    test("applies planning variant classes", () => {
      const { getByText } = renderWithUser(<Badge variant="planning">Planning</Badge>);
      const badge = getByText("Planning");
      expect(badge.className).toContain("bg-cyan-100");
    });

    test("applies running variant classes", () => {
      const { getByText } = renderWithUser(<Badge variant="running">Running</Badge>);
      const badge = getByText("Running");
      expect(badge.className).toContain("bg-blue-100");
    });

    test("applies completed variant classes", () => {
      const { getByText } = renderWithUser(<Badge variant="completed">Completed</Badge>);
      const badge = getByText("Completed");
      expect(badge.className).toContain("bg-green-100");
    });

    test("applies stopped variant classes", () => {
      const { getByText } = renderWithUser(<Badge variant="stopped">Stopped</Badge>);
      const badge = getByText("Stopped");
      expect(badge.className).toContain("bg-gray-100");
    });

    test("applies failed variant classes", () => {
      const { getByText } = renderWithUser(<Badge variant="failed">Failed</Badge>);
      const badge = getByText("Failed");
      expect(badge.className).toContain("bg-red-100");
    });

    test("applies merged variant classes", () => {
      const { getByText } = renderWithUser(<Badge variant="merged">Merged</Badge>);
      const badge = getByText("Merged");
      expect(badge.className).toContain("bg-purple-100");
    });

    test("applies pushed variant classes", () => {
      const { getByText } = renderWithUser(<Badge variant="pushed">Pushed</Badge>);
      const badge = getByText("Pushed");
      expect(badge.className).toContain("bg-indigo-100");
    });

    test("applies deleted variant classes", () => {
      const { getByText } = renderWithUser(<Badge variant="deleted">Deleted</Badge>);
      const badge = getByText("Deleted");
      expect(badge.className).toContain("bg-gray-100");
    });
  });

  describe("sizes", () => {
    test("applies sm size classes by default", () => {
      const { getByText } = renderWithUser(<Badge>Small</Badge>);
      const badge = getByText("Small");
      expect(badge.className).toContain("px-2");
      expect(badge.className).toContain("text-xs");
    });

    test("applies md size classes", () => {
      const { getByText } = renderWithUser(<Badge size="md">Medium</Badge>);
      const badge = getByText("Medium");
      expect(badge.className).toContain("px-2.5");
      expect(badge.className).toContain("text-sm");
    });
  });

  describe("custom className", () => {
    test("appends custom className", () => {
      const { getByText } = renderWithUser(<Badge className="ml-2">Custom</Badge>);
      const badge = getByText("Custom");
      expect(badge.className).toContain("ml-2");
    });
  });

  describe("HTML attributes", () => {
    test("forwards data attributes", () => {
      const { getByTestId } = renderWithUser(<Badge data-testid="my-badge">Test</Badge>);
      expect(getByTestId("my-badge")).toBeInTheDocument();
    });
  });
});

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
