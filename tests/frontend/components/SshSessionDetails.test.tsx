import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createMockApi } from "../helpers/mock-api";
import { createMockWebSocket } from "../helpers/mock-websocket";
import { createSshSession } from "../helpers/factories";
import { act, renderWithUser, waitFor } from "../helpers/render";
import {
  lastMockTerminal as lastTerminal,
  lastMockTerminalOptions as lastTerminalOptions,
  resetGhosttyWebMockState,
} from "../helpers/mock-ghostty-web";
import { SshSessionDetails } from "@/components/SshSessionDetails";
import { clearStoredSshServerCredential } from "@/lib/ssh-browser-credentials";

let clipboardWrites: string[] = [];
const originalDocumentFonts = "fonts" in document ? document.fonts : undefined;
const expectedTerminalTheme = {
  background: "#1e1e1e",
  foreground: "#d4d4d4",
  cursor: "#aeafad",
  cursorAccent: "#1e1e1e",
  selectionBackground: "#264f78",
  selectionForeground: "#ffffff",
  black: "#000000",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#ffffff",
} as const;

function restoreDocumentFonts() {
  if (originalDocumentFonts === undefined) {
    Reflect.deleteProperty(document, "fonts");
    return;
  }

  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: originalDocumentFonts,
  });
}

function mockDocumentFonts(availableFontFamilies: readonly string[]) {
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: {
      load: async () => [],
      ready: Promise.resolve(),
      check: (fontDeclaration: string) =>
        availableFontFamilies.some((fontFamily) =>
          fontDeclaration.includes(`"${fontFamily}"`) || fontDeclaration.includes(fontFamily)
        ),
    },
  });
}

const api = createMockApi();
const ws = createMockWebSocket();
const TEST_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAsKNhd9E/OQ+lbqKlfYjv
69xGawOr9J0cMf2Qj3jWXaXv6mm1xrDBMYNboWkjxV6AZAG9zDJO6s8eP/rj7s3P
7dfmoHGRfqoItqqt6WkKxZxjrnDc0l43wcdGaGm0fL5f4enJv+0Ft9Y+BSHhMl+m
ENb+JvTFFK3bz38eLI8Td2RLIqjQ+bTR0M55VdlyIJvtZ4bAzn9IdABzd8hIp/Fq
ZI97s5nsyDqX5ePG7e9UY9kfF4sxhQ1jlwmkIYlQmVl3zY6fWihc+YVHL7XWE/90
cwJp+7qyc0w90j+5vMuJcfFm7F8FG7Zz+oOkkeNbeqMHEaJwVIi9vtHbljH5jtmd
Tib0ROswpXTuhp2cDEgfZiF5m6o6Yws1eIqUhYaEfpOUqseYjPe6Klbjyl90m7Xq
QpPbjq5q7UL/ase5r4n4t0JgcLZw1oP98rVAx+VFE+UViVd9qqH7CFhxxR9t7LFa
NwUWw/pj0oI3Qul2lJfXaogfXzdcguVRik/yi0zQ5p5ArRBPEtmeNcEqA9x1ApNQ
h8ND8r3lVAjFrX8+pj1fmPSxaIXgQPywAzr5kgdWz3BOEkrd5alvd+6kLxC2ErMA
tYXzrp47C+1F7elWjBhHsqlhHSl7zQxqXqetisXZ4uEyv+4S0M3O+Q+iLeidcbLQ
Vrt5VIv2q/QnK29KDywKJrsCAwEAAQ==
-----END PUBLIC KEY-----`;

describe("SshSessionDetails", () => {
  beforeEach(() => {
    api.reset();
    api.install();
    ws.reset();
    ws.install();
    clearStoredSshServerCredential("server-1");
    resetGhosttyWebMockState();
    clipboardWrites = [];
    restoreDocumentFonts();
    // Default to non-focus mode for tests that don't specifically test focus mode,
    // so they can interact with the header and session info normally.
    globalThis.localStorage?.setItem("ralpher-ssh-focus-mode", "false");
  });

  afterEach(() => {
    api.uninstall();
    ws.uninstall();
    clearStoredSshServerCredential("server-1");
    globalThis.localStorage?.clear();
    restoreDocumentFonts();
  });

  test("starts with compact collapsed bars and no redundant terminal action buttons", async () => {
    api.get("/api/ssh-sessions/:id", (req) =>
      createSshSession({ config: { id: req.params["id"]!, name: "SSH Compact Layout" } }),
    );

    const { getByText, queryByText, user } = renderWithUser(
      <SshSessionDetails sshSessionId="ssh-compact-1" onBack={() => {}} />,
    );

    await waitFor(() => {
      expect(getByText("SSH Compact Layout")).toBeTruthy();
      expect(ws.getConnections("/api/ssh-terminal")).toHaveLength(1);
      expect(lastTerminal).not.toBeNull();
    });

    expect(queryByText("Refresh")).toBeNull();
    expect(queryByText("Reconnect Terminal")).toBeNull();
    expect(queryByText("Workspace ID")).toBeNull();
    expect(queryByText("Ctrl")).toBeNull();
    expect(document.querySelector("button button")).toBeNull();

    await user.click(getByText("Session Info"));
    await waitFor(() => {
      expect(getByText("Workspace ID")).toBeTruthy();
    });

    await user.click(getByText("Touch controls"));
    await waitFor(() => {
      expect(getByText("Ctrl")).toBeTruthy();
    });
  });

  test("wraps long session names and identifiers in the header and session info panel", async () => {
    const longName = `SSH ${"very-long-session-name-".repeat(6)}`;
    const longDirectory = `/workspaces/${"nested-ssh-directory-".repeat(6)}project`;
    const longRemoteId = `ralpher-${"very-long-persistent-id-".repeat(5)}`;

    api.get("/api/ssh-sessions/:id", (req) =>
      createSshSession({
        config: {
          id: req.params["id"]!,
          name: longName,
          directory: longDirectory,
          remoteSessionName: longRemoteId,
        },
        state: { status: "connected" },
      }),
    );

    const { getByText, getAllByText, user } = renderWithUser(
      <SshSessionDetails sshSessionId="ssh-wrap-1" onBack={() => {}} />,
    );

    await waitFor(() => {
      expect(getByText(longName)).toBeTruthy();
      expect(ws.getConnections("/api/ssh-terminal")).toHaveLength(1);
    });

    const title = getByText(longName);
    expect(title.className).toContain("break-words");
    expect(title.className).toContain("[overflow-wrap:anywhere]");
    expect(title.className.includes("truncate")).toBe(false);

    await user.click(getByText("Session Info"));
    await waitFor(() => {
      expect(getByText(longDirectory)).toBeTruthy();
    });

    const directory = getByText(longDirectory);
    expect(directory.className).toContain("break-words");
    expect(directory.className).toContain("[overflow-wrap:anywhere]");

    const remoteId = getAllByText((_content, element) =>
      element?.textContent?.includes(longRemoteId) ?? false
    ).find((element) =>
      element instanceof HTMLElement && element.className.includes("break-words")
    );
    expect(remoteId).toBeTruthy();
    if (!(remoteId instanceof HTMLElement)) {
      throw new Error("Expected wrapped remote session identifier in SSH session details");
    }
    expect(remoteId.className).toContain("[overflow-wrap:anywhere]");
    expect(remoteId.className.includes("truncate")).toBe(false);
  });

  test("hides the back button when embedded in the shell", async () => {
    api.get("/api/ssh-sessions/:id", (req) =>
      createSshSession({ config: { id: req.params["id"]!, name: "SSH Embedded Layout" } }),
    );

    const { getByText, queryByRole } = renderWithUser(
      <SshSessionDetails sshSessionId="ssh-embedded-1" showBackButton={false} />,
    );

    await waitFor(() => {
      expect(getByText("SSH Embedded Layout")).toBeTruthy();
      expect(queryByRole("button", { name: /Back/ })).toBeNull();
    });
  });

  test("initializes the terminal with the configured ghostty-web font size and without xterm-specific rendering tweaks", async () => {
    api.get("/api/ssh-sessions/:id", (req) =>
      createSshSession({ config: { id: req.params["id"]!, name: "SSH Terminal Rendering" } }),
    );

    const { getByText } = renderWithUser(
      <SshSessionDetails sshSessionId="ssh-rendering-1" onBack={() => {}} />,
    );

    await waitFor(() => {
      expect(getByText("SSH Terminal Rendering")).toBeTruthy();
      expect(ws.getConnections("/api/ssh-terminal")).toHaveLength(1);
      expect(lastTerminal).not.toBeNull();
    });

    expect(lastTerminalOptions).toEqual({
      fontSize: 12,
      fontFamily: "SFMono-Regular, \"SF Mono\", Menlo, Monaco, Consolas, \"Liberation Mono\", monospace, \"Liga SFMono Nerd Font\", \"MesloLGS NF\", \"MonaspiceNe Nerd Font Mono\", \"MonaspiceXe Nerd Font Mono\", \"Iosevka Nerd Font\", \"RecMonoLinear Nerd Font Mono\", \"Terminess Nerd Font Mono\", \"FiraCode Nerd Font Mono\", \"CaskaydiaMono Nerd Font Mono\", \"CaskaydiaCove Nerd Font Mono\", \"JetBrainsMono Nerd Font Mono\", \"JetBrainsMono Nerd Font\", \"Hack Nerd Font Mono\", \"SauceCodePro Nerd Font Mono\", \"Symbols Nerd Font Mono\", \"Symbols Nerd Font\", \"Ralpher Terminal Nerd Font\"",
      theme: expectedTerminalTheme,
    });
  });

  test("hides the browser caret on the contenteditable terminal host", async () => {
    api.get("/api/ssh-sessions/:id", (req) =>
      createSshSession({ config: { id: req.params["id"]!, name: "SSH Hidden Browser Caret" } }),
    );

    const { getByText } = renderWithUser(
      <SshSessionDetails sshSessionId="ssh-hidden-caret-1" onBack={() => {}} />,
    );

    await waitFor(() => {
      expect(getByText("SSH Hidden Browser Caret")).toBeTruthy();
      expect(lastTerminal).not.toBeNull();
      expect(lastTerminal?.element).not.toBeUndefined();
    });

    const terminalHost = lastTerminal!.element!;
    expect(terminalHost.style.caretColor).toBe("transparent");
    expect(terminalHost.classList.contains("caret-transparent")).toBe(true);
  });

  test("does not refocus the terminal after ghostty open already focused it", async () => {
    api.get("/api/ssh-sessions/:id", (req) =>
      createSshSession({ config: { id: req.params["id"]!, name: "SSH Initial Focus" } }),
    );

    const { getByText } = renderWithUser(
      <SshSessionDetails sshSessionId="ssh-initial-focus-1" onBack={() => {}} />,
    );

    await waitFor(() => {
      expect(getByText("SSH Initial Focus")).toBeTruthy();
      expect(lastTerminal).not.toBeNull();
    });

    expect(lastTerminal?.focusCalls).toBe(1);
  });

  test("prefers local Nerd fonts over the bundled fallback font when available", async () => {
    api.get("/api/ssh-sessions/:id", (req) =>
      createSshSession({ config: { id: req.params["id"]!, name: "SSH Local Font Preference" } }),
    );
    mockDocumentFonts(["Liga SFMono Nerd Font", "Ralpher Terminal Nerd Font"]);

    const { getByText } = renderWithUser(
      <SshSessionDetails sshSessionId="ssh-local-fonts-1" onBack={() => {}} />,
    );

    await waitFor(() => {
      expect(getByText("SSH Local Font Preference")).toBeTruthy();
      expect(ws.getConnections("/api/ssh-terminal")).toHaveLength(1);
      expect(lastTerminal).not.toBeNull();
    });

    expect(lastTerminalOptions).toEqual({
      fontSize: 12,
      fontFamily: "SFMono-Regular, \"SF Mono\", Menlo, Monaco, Consolas, \"Liberation Mono\", monospace, \"Liga SFMono Nerd Font\", \"Ralpher Terminal Nerd Font\"",
      theme: expectedTerminalTheme,
    });
  });

  test("answers OSC 4/10/11 color queries without writing them into the terminal output", async () => {
    api.get("/api/ssh-sessions/:id", (req) =>
      createSshSession({ config: { id: req.params["id"]!, name: "SSH OSC Colors" } }),
    );

    const { getByText } = renderWithUser(
      <SshSessionDetails sshSessionId="ssh-osc-colors-1" onBack={() => {}} />,
    );

    await waitFor(() => {
      expect(getByText("SSH OSC Colors")).toBeTruthy();
      expect(ws.getConnections("/api/ssh-terminal")).toHaveLength(1);
      expect(lastTerminal).not.toBeNull();
    });

    const terminalConnection = ws.getConnections("/api/ssh-terminal")[0]!;
    await act(async () => {
      ws.sendEventTo(terminalConnection, {
        type: "terminal.output",
        data: "\u001b]11;?\u001b\\\u001b]4;0;?\u001b\\",
      });
      ws.sendEventTo(terminalConnection, {
        type: "terminal.output",
        data: "\u001b]4;2;?\u001b\\\u001b]10;?\u001b\\Thinking...\r\n",
      });
    });

    expect(lastTerminal!.writes).toContain("Thinking...\r\n");
    expect(lastTerminal!.writes.some((chunk) =>
      chunk.includes("\u001b]11;?")
      || chunk.includes("\u001b]10;?")
      || chunk.includes("\u001b]4;0;?")
      || chunk.includes("\u001b]4;2;?")
    )).toBe(false);
    expect(terminalConnection.sentMessages).toContain(JSON.stringify({
      type: "terminal.input",
      data: "\u001b]4;0;rgb:00/00/00\u001b\\",
    }));
    expect(terminalConnection.sentMessages).toContain(JSON.stringify({
      type: "terminal.input",
      data: "\u001b]4;2;rgb:0d/bc/79\u001b\\",
    }));
    expect(terminalConnection.sentMessages).toContain(JSON.stringify({
      type: "terminal.input",
      data: "\u001b]11;rgb:1e/1e/1e\u001b\\",
    }));
    expect(terminalConnection.sentMessages).toContain(JSON.stringify({
      type: "terminal.input",
      data: "\u001b]10;rgb:d4/d4/d4\u001b\\",
    }));
  });

  test("falls back to raw output when an OSC color query exceeds the pending buffer limit", async () => {
    api.get("/api/ssh-sessions/:id", (req) =>
      createSshSession({ config: { id: req.params["id"]!, name: "SSH OSC Overflow" } }),
    );

    const { getByText } = renderWithUser(
      <SshSessionDetails sshSessionId="ssh-osc-overflow-1" onBack={() => {}} />,
    );

    await waitFor(() => {
      expect(getByText("SSH OSC Overflow")).toBeTruthy();
      expect(ws.getConnections("/api/ssh-terminal")).toHaveLength(1);
      expect(lastTerminal).not.toBeNull();
    });

    const terminalConnection = ws.getConnections("/api/ssh-terminal")[0]!;
    const overflowingOscQuery = `\u001b]4;${"0;?".repeat(1_500)}`;
    await act(async () => {
      ws.sendEventTo(terminalConnection, {
        type: "terminal.output",
        data: overflowingOscQuery,
      });
      ws.sendEventTo(terminalConnection, {
        type: "terminal.output",
        data: "still-rendered\r\n",
      });
    });

    expect(lastTerminal!.writes).toContain(overflowingOscQuery);
    expect(lastTerminal!.writes).toContain("still-rendered\r\n");
    expect(
      terminalConnection.sentMessages.filter((message) => message.includes("\"type\":\"terminal.input\"")),
    ).toEqual([]);
  });

  test("renames a workspace SSH session from the details view", async () => {
    api.get("/api/ssh-sessions/:id", (req) =>
      createSshSession({ config: { id: req.params["id"]!, name: "SSH Before Rename" } }),
    );
    api.patch("/api/ssh-sessions/:id", (req) => {
      const body = req.body as { name: string };
      return createSshSession({
        config: { id: req.params["id"]!, name: body.name },
      });
    });

    const { getByRole, getByLabelText, getByText, user } = renderWithUser(
      <SshSessionDetails sshSessionId="ssh-rename-details-1" onBack={() => {}} />,
    );

    await waitFor(() => {
      expect(getByText("SSH Before Rename")).toBeTruthy();
      expect(getByRole("button", { name: "Rename SSH session" })).toBeTruthy();
    });

    await user.click(getByRole("button", { name: "Rename SSH session" }));

    await waitFor(() => {
      expect(getByRole("heading", { name: "Rename SSH Session" })).toBeTruthy();
    });

    const input = getByLabelText("SSH Session Name") as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "SSH After Rename");
    await user.click(getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(getByText("SSH After Rename")).toBeTruthy();
    });

    const renameCalls = api.calls("/api/ssh-sessions/:id", "PATCH");
    expect(renameCalls).toHaveLength(1);
    expect(renameCalls[0]?.body).toEqual({ name: "SSH After Rename" });
  });

  test("forwards wheel events as SGR mouse input when terminal mouse tracking is enabled", async () => {
    api.get("/api/ssh-sessions/:id", (req) =>
      createSshSession({ config: { id: req.params["id"]!, name: "SSH Mouse Wheel" } }),
    );

    const { getByText } = renderWithUser(
      <SshSessionDetails sshSessionId="ssh-mouse-wheel-1" onBack={() => {}} />,
    );

    await waitFor(() => {
      expect(getByText("SSH Mouse Wheel")).toBeTruthy();
      expect(ws.getConnections("/api/ssh-terminal")).toHaveLength(1);
      expect(lastTerminal?.canvas).not.toBeNull();
    });

    lastTerminal!.mouseTracking = true;
    lastTerminal!.modes[1000] = true;
    lastTerminal!.modes[1006] = true;

    const terminalConnection = ws.getConnections("/api/ssh-terminal")[0]!;
    await act(async () => {
      ws.sendEventTo(terminalConnection, {
        type: "terminal.connected",
        sshSessionId: "ssh-mouse-wheel-1",
      });
    });

    await act(async () => {
      const event = new WheelEvent("wheel", {
        deltaY: 120,
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperties(event, {
        clientX: {
          configurable: true,
          value: 100,
        },
        clientY: {
          configurable: true,
          value: 40,
        },
      });
      lastTerminal!.canvas!.dispatchEvent(event);
    });

    expect(terminalConnection.sentMessages).toContain(JSON.stringify({
      type: "terminal.input",
      data: "\u001b[<65;11;3M",
    }));
  });

  test("forwards click press and release as SGR mouse input when terminal mouse tracking is enabled", async () => {
    api.get("/api/ssh-sessions/:id", (req) =>
      createSshSession({ config: { id: req.params["id"]!, name: "SSH Mouse Click" } }),
    );

    const { getByText } = renderWithUser(
      <SshSessionDetails sshSessionId="ssh-mouse-click-1" onBack={() => {}} />,
    );

    await waitFor(() => {
      expect(getByText("SSH Mouse Click")).toBeTruthy();
      expect(ws.getConnections("/api/ssh-terminal")).toHaveLength(1);
      expect(lastTerminal?.canvas).not.toBeNull();
    });

    lastTerminal!.mouseTracking = true;
    lastTerminal!.modes[1000] = true;
    lastTerminal!.modes[1006] = true;

    const terminalConnection = ws.getConnections("/api/ssh-terminal")[0]!;
    await act(async () => {
      ws.sendEventTo(terminalConnection, {
        type: "terminal.connected",
        sshSessionId: "ssh-mouse-click-1",
      });
    });

    await act(async () => {
      lastTerminal!.canvas!.dispatchEvent(new MouseEvent("mousedown", {
        button: 0,
        buttons: 1,
        clientX: 30,
        clientY: 20,
        bubbles: true,
        cancelable: true,
      }));
      lastTerminal!.canvas!.dispatchEvent(new MouseEvent("mouseup", {
        button: 0,
        buttons: 0,
        clientX: 30,
        clientY: 20,
        bubbles: true,
        cancelable: true,
      }));
      lastTerminal!.canvas!.dispatchEvent(new MouseEvent("click", {
        button: 0,
        clientX: 30,
        clientY: 20,
        bubbles: true,
        cancelable: true,
      }));
    });

    expect(terminalConnection.sentMessages).toContain(JSON.stringify({
      type: "terminal.input",
      data: "\u001b[<0;4;2M",
    }));
    expect(terminalConnection.sentMessages).toContain(JSON.stringify({
      type: "terminal.input",
      data: "\u001b[<0;4;2m",
    }));
  });

  test("sends BackTab for physical Shift+Tab instead of collapsing it into plain Tab", async () => {
    api.get("/api/ssh-sessions/:id", (req) =>
      createSshSession({ config: { id: req.params["id"]!, name: "SSH Shift Tab" } }),
    );

    const { getByText } = renderWithUser(
      <SshSessionDetails sshSessionId="ssh-shift-tab-1" onBack={() => {}} />,
    );

    await waitFor(() => {
      expect(getByText("SSH Shift Tab")).toBeTruthy();
      expect(ws.getConnections("/api/ssh-terminal")).toHaveLength(1);
      expect(lastTerminal?.keyHandler).toBeDefined();
    });

    const terminalConnection = ws.getConnections("/api/ssh-terminal")[0]!;
    await act(async () => {
      ws.sendEventTo(terminalConnection, {
        type: "terminal.connected",
        sshSessionId: "ssh-shift-tab-1",
      });
    });

    const handled = lastTerminal!.keyHandler!(
      new KeyboardEvent("keydown", {
        key: "Tab",
        code: "Tab",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(handled).toBe(true);
    expect(terminalConnection.sentMessages).toContain(JSON.stringify({
      type: "terminal.input",
      data: "\u001b[Z",
    }));
  });

  test("applies active modifiers to the next typed terminal key and touch key", async () => {
    api.get("/api/ssh-sessions/:id", (req) =>
      createSshSession({ config: { id: req.params["id"]!, name: "SSH Mobile Session" } }),
    );

    const { getByText, user } = renderWithUser(
      <SshSessionDetails sshSessionId="ssh-mobile-1" onBack={() => {}} />,
    );

    await waitFor(() => {
      expect(getByText("SSH Mobile Session")).toBeTruthy();
    });

    await waitFor(() => {
      expect(ws.getConnections("/api/ssh-terminal")).toHaveLength(1);
      expect(lastTerminal).not.toBeNull();
    });

    const terminalConnection = ws.getConnections("/api/ssh-terminal")[0]!;
    await act(async () => {
      ws.sendEventTo(terminalConnection, {
        type: "terminal.connected",
        sshSessionId: "ssh-mobile-1",
      });
    });

    await user.click(getByText("Touch controls"));
    await user.click(getByText("Ctrl"));
    await act(async () => {
      lastTerminal?.dataHandler?.("c");
    });

    await waitFor(() => {
      expect(terminalConnection.sentMessages).toContain(JSON.stringify({
        type: "terminal.input",
        data: "\u0003",
      }));
    });

    expect(getByText("Modifiers off")).toBeTruthy();

    await user.click(getByText("Alt"));
    await user.click(getByText("↑"));

    await waitFor(() => {
      expect(terminalConnection.sentMessages).toContain(JSON.stringify({
        type: "terminal.input",
        data: "\u001b[1;3A",
      }));
    });
  });

  test("keeps the terminal mounted, refocuses it, and sends no input until a real key", async () => {
    api.get("/api/ssh-sessions/:id", (req) =>
      createSshSession({ config: { id: req.params["id"]!, name: "SSH Modifier Stability" } }),
    );

    const { getByText, user } = renderWithUser(
      <SshSessionDetails sshSessionId="ssh-mobile-modifier-stability" onBack={() => {}} />,
    );

    await waitFor(() => {
      expect(getByText("SSH Modifier Stability")).toBeTruthy();
    });

    await waitFor(() => {
      expect(ws.getConnections("/api/ssh-terminal")).toHaveLength(1);
      expect(lastTerminal).not.toBeNull();
    });

    const terminalConnection = ws.getConnections("/api/ssh-terminal")[0]!;
    await act(async () => {
      ws.sendEventTo(terminalConnection, {
        type: "terminal.connected",
        sshSessionId: "ssh-mobile-modifier-stability",
      });
    });

    await user.click(getByText("Touch controls"));

    const initialTerminal = lastTerminal;
    const initialFocusCalls = initialTerminal?.focusCalls ?? 0;
    const initialInputMessages = terminalConnection.sentMessages.filter((message) =>
      message.includes("\"type\":\"terminal.input\"")
    );

    await user.click(getByText("Ctrl"));

    expect(lastTerminal).toBe(initialTerminal);
    expect(lastTerminal?.focusCalls).toBe(initialFocusCalls + 1);
    expect(
      terminalConnection.sentMessages.filter((message) => message.includes("\"type\":\"terminal.input\"")),
    ).toEqual(initialInputMessages);
  });

  test("supports shift-tab from the touch controls", async () => {
    api.get("/api/ssh-sessions/:id", (req) =>
      createSshSession({ config: { id: req.params["id"]!, name: "SSH Shift Tab" } }),
    );

    const { getByText, user } = renderWithUser(
      <SshSessionDetails sshSessionId="ssh-mobile-2" onBack={() => {}} />,
    );

    await waitFor(() => {
      expect(getByText("SSH Shift Tab")).toBeTruthy();
    });

    await waitFor(() => {
      expect(ws.getConnections("/api/ssh-terminal")).toHaveLength(1);
      expect(lastTerminal).not.toBeNull();
    });

    const terminalConnection = ws.getConnections("/api/ssh-terminal")[0]!;
    await act(async () => {
      ws.sendEventTo(terminalConnection, {
        type: "terminal.connected",
        sshSessionId: "ssh-mobile-2",
      });
    });

    await user.click(getByText("Touch controls"));
    await user.click(getByText("Shift"));
    await user.click(getByText("Tab"));

    await waitFor(() => {
      expect(terminalConnection.sentMessages).toContain(JSON.stringify({
        type: "terminal.input",
        data: "\u001b[Z",
      }));
    });
  });

  test("sends a Ctrl+C touch shortcut", async () => {
    api.get("/api/ssh-sessions/:id", (req) =>
      createSshSession({ config: { id: req.params["id"]!, name: "SSH Ctrl C" } }),
    );

    const { getByText, user } = renderWithUser(
      <SshSessionDetails sshSessionId="ssh-mobile-ctrl-c" onBack={() => {}} />,
    );

    await waitFor(() => {
      expect(getByText("SSH Ctrl C")).toBeTruthy();
    });

    await waitFor(() => {
      expect(ws.getConnections("/api/ssh-terminal")).toHaveLength(1);
      expect(lastTerminal).not.toBeNull();
    });

    const terminalConnection = ws.getConnections("/api/ssh-terminal")[0]!;
    await act(async () => {
      ws.sendEventTo(terminalConnection, {
        type: "terminal.connected",
        sshSessionId: "ssh-mobile-ctrl-c",
      });
    });

    await user.click(getByText("Touch controls"));
    await user.click(getByText("Ctrl+C"));

    await waitFor(() => {
      expect(terminalConnection.sentMessages).toContain(JSON.stringify({
        type: "terminal.input",
        data: "\u0003",
      }));
    });
  });

  test("sends raw text shortcuts from touch controls", async () => {
    api.get("/api/ssh-sessions/:id", (req) =>
      createSshSession({ config: { id: req.params["id"]!, name: "SSH Text Shortcuts" } }),
    );

    const { getByText, user } = renderWithUser(
      <SshSessionDetails sshSessionId="ssh-mobile-text-shortcuts" onBack={() => {}} />,
    );

    await waitFor(() => {
      expect(getByText("SSH Text Shortcuts")).toBeTruthy();
    });

    await waitFor(() => {
      expect(ws.getConnections("/api/ssh-terminal")).toHaveLength(1);
      expect(lastTerminal).not.toBeNull();
    });

    const terminalConnection = ws.getConnections("/api/ssh-terminal")[0]!;
    await act(async () => {
      ws.sendEventTo(terminalConnection, {
        type: "terminal.connected",
        sshSessionId: "ssh-mobile-text-shortcuts",
      });
    });

    await user.click(getByText("Touch controls"));
    await user.click(getByText("Install Neovim"));
    await user.click(getByText("Neovim"));
    await user.click(getByText("Ntree"));
    await user.click(getByText(":q"));
    await user.click(getByText("Install fresh"));
    await user.click(getByText("Fresh"));

    await waitFor(() => {
      expect(terminalConnection.sentMessages).toContain(JSON.stringify({
        type: "terminal.input",
        data: "sudo apt update && sudo apt install neovim",
      }));
      expect(terminalConnection.sentMessages).toContain(JSON.stringify({
        type: "terminal.input",
        data: "nvim\n",
      }));
      expect(terminalConnection.sentMessages).toContain(JSON.stringify({
        type: "terminal.input",
        data: ":Ntree\n",
      }));
      expect(terminalConnection.sentMessages).toContain(JSON.stringify({
        type: "terminal.input",
        data: ":q\n",
      }));
      expect(terminalConnection.sentMessages).toContain(JSON.stringify({
        type: "terminal.input",
        data: "curl https://raw.githubusercontent.com/sinelaw/fresh/refs/heads/master/scripts/install.sh | sh",
      }));
      expect(terminalConnection.sentMessages).toContain(JSON.stringify({
        type: "terminal.input",
        data: "fresh\n",
      }));
    });
  });

  test("wraps touch controls instead of forcing horizontal scrolling", async () => {
    api.get("/api/ssh-sessions/:id", (req) =>
      createSshSession({ config: { id: req.params["id"]!, name: "SSH Wrapped Controls" } }),
    );

    const { getByRole, getByText, getByTestId, user } = renderWithUser(
      <SshSessionDetails sshSessionId="ssh-mobile-wrap" onBack={() => {}} />,
    );

    await waitFor(() => {
      expect(getByText("SSH Wrapped Controls")).toBeTruthy();
    });

    await user.click(getByText("Touch controls"));

    await waitFor(() => {
      expect(getByRole("button", { name: "↓" })).toBeTruthy();
    });

    const layout = getByTestId("ssh-touch-controls-layout");
    const buttons = getByTestId("ssh-touch-controls-buttons");

    expect(layout.className).not.toContain("overflow-x-auto");
    expect(buttons.className).toContain("flex-wrap");
    expect(buttons.className).not.toContain("min-w-max");
  });

  test("keeps neovim and fresh touch controls grouped at the end after separators", async () => {
    api.get("/api/ssh-sessions/:id", (req) =>
      createSshSession({ config: { id: req.params["id"]!, name: "SSH Neovim Group" } }),
    );

    const { getByText, getByTestId, user } = renderWithUser(
      <SshSessionDetails sshSessionId="ssh-mobile-neovim-group" onBack={() => {}} />,
    );

    await waitFor(() => {
      expect(getByText("SSH Neovim Group")).toBeTruthy();
    });

    await user.click(getByText("Touch controls"));

    const buttons = getByTestId("ssh-touch-controls-buttons");
    const buttonLabels = Array.from(buttons.querySelectorAll("button")).map((button) =>
      button.textContent?.trim() ?? "",
    );
    const separators = buttons.querySelectorAll("span[aria-hidden='true']");

    expect(buttonLabels.slice(-6, -2)).toEqual([
      "Install Neovim",
      "Neovim",
      "Ntree",
      ":q",
    ]);
    expect(buttonLabels.slice(-2)).toEqual([
      "Install fresh",
      "Fresh",
    ]);
    expect(separators).toHaveLength(4);
  });

  test("prevents touch controls from taking focus on press", async () => {
    api.get("/api/ssh-sessions/:id", (req) =>
      createSshSession({ config: { id: req.params["id"]!, name: "SSH Preserve Keyboard" } }),
    );

    const { getByText, getByRole, user } = renderWithUser(
      <SshSessionDetails sshSessionId="ssh-mobile-preserve-keyboard" onBack={() => {}} />,
    );

    await waitFor(() => {
      expect(getByText("SSH Preserve Keyboard")).toBeTruthy();
    });

    await user.click(getByText("Touch controls"));

    const ctrlButton = getByRole("button", { name: "Ctrl" });
    const arrowDownButton = getByRole("button", { name: "↓" });

    const ctrlMouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    const arrowMouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });

    expect(ctrlButton.dispatchEvent(ctrlMouseDown)).toBe(false);
    expect(ctrlMouseDown.defaultPrevented).toBe(true);
    expect(arrowDownButton.dispatchEvent(arrowMouseDown)).toBe(false);
    expect(arrowMouseDown.defaultPrevented).toBe(true);
  });

  test("waits for terminal readiness before sending the initial resize", async () => {
    api.get("/api/ssh-sessions/:id", (req) =>
      createSshSession({ config: { id: req.params["id"]!, name: "SSH Ready Gate" } }),
    );

    const { getByText } = renderWithUser(
      <SshSessionDetails sshSessionId="ssh-ready-1" onBack={() => {}} />,
    );

    await waitFor(() => {
      expect(getByText("SSH Ready Gate")).toBeTruthy();
      expect(ws.getConnections("/api/ssh-terminal")).toHaveLength(1);
      expect(lastTerminal).not.toBeNull();
    });

    const terminalConnection = ws.getConnections("/api/ssh-terminal")[0]!;
    const resizePayload = JSON.stringify({
      type: "terminal.resize",
      cols: 80,
      rows: 24,
    });

    expect(terminalConnection.sentMessages).not.toContain(resizePayload);

    await act(async () => {
      ws.sendEventTo(terminalConnection, {
        type: "terminal.connected",
        sshSessionId: "ssh-ready-1",
      });
    });

    await waitFor(() => {
      expect(terminalConnection.sentMessages).toContain(resizePayload);
    });
  });

  test("treats the first terminal output as a readiness fallback when terminal.connected is missing", async () => {
    api.get("/api/ssh-sessions/:id", (req) =>
      createSshSession({ config: { id: req.params["id"]!, name: "SSH Buffered Output" } }),
    );

    const { getByText } = renderWithUser(
      <SshSessionDetails sshSessionId="ssh-buffer-1" onBack={() => {}} />,
    );

    await waitFor(() => {
      expect(getByText("SSH Buffered Output")).toBeTruthy();
      expect(ws.getConnections("/api/ssh-terminal")).toHaveLength(1);
      expect(lastTerminal).not.toBeNull();
    });

    const terminalConnection = ws.getConnections("/api/ssh-terminal")[0]!;
    const resizePayload = JSON.stringify({
      type: "terminal.resize",
      cols: 80,
      rows: 24,
    });

    await act(async () => {
      ws.sendEventTo(terminalConnection, {
        type: "terminal.output",
        data: "prompt$ ",
      });
    });

    await waitFor(() => {
      expect(lastTerminal?.writes).toContain("prompt$ ");
      expect(terminalConnection.sentMessages).toContain(resizePayload);
      expect(getByText("connected")).toBeTruthy();
    });
  });

  test("marks the terminal as disconnected when a terminal.error arrives before readiness", async () => {
    api.get("/api/ssh-sessions/:id", (req) =>
      createSshSession({ config: { id: req.params["id"]!, name: "SSH Terminal Error" } }),
    );

    const { getByText } = renderWithUser(
      <SshSessionDetails sshSessionId="ssh-terminal-error-1" onBack={() => {}} />,
    );

    await waitFor(() => {
      expect(getByText("SSH Terminal Error")).toBeTruthy();
      expect(ws.getConnections("/api/ssh-terminal")).toHaveLength(1);
      expect(lastTerminal).not.toBeNull();
    });

    const terminalConnection = ws.getConnections("/api/ssh-terminal")[0]!;

    await act(async () => {
      ws.sendEventTo(terminalConnection, {
        type: "terminal.error",
        message: "SSH terminal is not connected",
      });
    });

    await waitFor(() => {
      expect(getByText("disconnected")).toBeTruthy();
    });

    expect(lastTerminal?.writes.some((chunk) => chunk.includes("SSH terminal is not connected"))).toBe(true);
    expect(terminalConnection.instance.readyState).toBe(WebSocket.CLOSED);
  });

  test("keeps the terminal mounted during SSH session status refreshes", async () => {
    api.get("/api/ssh-sessions/:id", (req) =>
      createSshSession({ config: { id: req.params["id"]!, name: "SSH Refresh Stable" } }),
    );

    const { getByText, queryByText } = renderWithUser(
      <SshSessionDetails sshSessionId="ssh-refresh-1" onBack={() => {}} />,
    );

    await waitFor(() => {
      expect(getByText("SSH Refresh Stable")).toBeTruthy();
      expect(ws.getConnections("/api/ssh-terminal")).toHaveLength(1);
      expect(ws.getConnections("/api/ws?sshSessionId=ssh-refresh-1")).toHaveLength(1);
      expect(lastTerminal).not.toBeNull();
    });

    const terminalConnection = ws.getConnections("/api/ssh-terminal")[0]!;
    const sessionConnection = ws.getConnections("/api/ws?sshSessionId=ssh-refresh-1")[0]!;

    await act(async () => {
      ws.sendEventTo(terminalConnection, {
        type: "terminal.connected",
        sshSessionId: "ssh-refresh-1",
      });
    });

    await act(async () => {
      ws.sendEventTo(sessionConnection, {
        type: "ssh_session.status",
        sshSessionId: "ssh-refresh-1",
        status: "connected",
        timestamp: new Date().toISOString(),
      });
    });

    await waitFor(() => {
      expect(queryByText("Loading SSH session...")).toBeNull();
      expect(ws.getConnections("/api/ssh-terminal")).toHaveLength(1);
      expect(getByText("Touch controls")).toBeTruthy();
      expect(lastTerminal).not.toBeNull();
    });
  });

  test("reconnects the terminal when the tab becomes visible again after a disconnect", async () => {
    api.get("/api/ssh-sessions/:id", (req) =>
      createSshSession({ config: { id: req.params["id"]!, name: "SSH Focus Recovery" } }),
    );

    let visibilityState = "visible";
    const originalVisibilityState = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibilityState,
    });

    try {
      const { getByText } = renderWithUser(
        <SshSessionDetails sshSessionId="ssh-focus-recovery" onBack={() => {}} />,
      );

      await waitFor(() => {
        expect(getByText("SSH Focus Recovery")).toBeTruthy();
        expect(ws.getConnections("/api/ssh-terminal")).toHaveLength(1);
      });

      const initialConnection = ws.getConnections("/api/ssh-terminal")[0]!;
      await act(async () => {
        ws.sendEventTo(initialConnection, {
          type: "terminal.connected",
          sshSessionId: "ssh-focus-recovery",
        });
      });

      await waitFor(() => {
        expect(api.calls("/api/ssh-sessions/:id", "GET")).toHaveLength(2);
        expect(getByText("connected")).toBeTruthy();
      });

      await act(async () => {
        initialConnection.instance.close(1006, "network lost");
      });

      await waitFor(() => {
        expect(getByText("disconnected")).toBeTruthy();
      });

      visibilityState = "hidden";
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });

      expect(ws.getConnections("/api/ssh-terminal")).toHaveLength(1);

      visibilityState = "visible";
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
        window.dispatchEvent(new Event("focus"));
      });

      await waitFor(() => {
        expect(ws.getConnections("/api/ssh-terminal")).toHaveLength(2);
      });

      const recoveredConnections = ws.getConnections("/api/ssh-terminal");
      const recoveredConnection = recoveredConnections[recoveredConnections.length - 1]!;
      expect(recoveredConnection).not.toBe(initialConnection);

      await act(async () => {
        ws.sendEventTo(recoveredConnection, {
          type: "terminal.connected",
          sshSessionId: "ssh-focus-recovery",
        });
      });

      await waitFor(() => {
        expect(getByText("connected")).toBeTruthy();
        expect(api.calls("/api/ssh-sessions/:id", "GET")).toHaveLength(3);
      });
    } finally {
      if (originalVisibilityState) {
        Object.defineProperty(document, "visibilityState", originalVisibilityState);
      } else {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          get: () => "visible",
        });
      }
    }
  });

  test("clears the touch copy selection state across terminal disconnect and reconnect", async () => {
    api.get("/api/ssh-sessions/:id", (req) =>
      createSshSession({ config: { id: req.params["id"]!, name: "SSH Selection Recovery" } }),
    );

    let visibilityState = "visible";
    const originalVisibilityState = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibilityState,
    });

    try {
      const { getByRole, getByText, user } = renderWithUser(
        <SshSessionDetails
          sshSessionId="ssh-selection-recovery"
          onBack={() => {}}
          copyTextToClipboard={async (text) => {
            clipboardWrites.push(text);
          }}
        />,
      );

      await waitFor(() => {
        expect(getByText("SSH Selection Recovery")).toBeTruthy();
        expect(ws.getConnections("/api/ssh-terminal")).toHaveLength(1);
        expect(lastTerminal).not.toBeNull();
      });

      await user.click(getByText("Touch controls"));

      const copySelectionButton = getByRole("button", { name: "Copy selection" });
      expect(copySelectionButton).toBeDisabled();

      await act(async () => {
        lastTerminal?.setSelection("stale selection");
      });

      await waitFor(() => {
        expect(copySelectionButton).not.toBeDisabled();
      });

      const initialConnection = ws.getConnections("/api/ssh-terminal")[0]!;
      await act(async () => {
        initialConnection.instance.close(1006, "network lost");
      });

      await waitFor(() => {
        expect(copySelectionButton).toBeDisabled();
      });

      await user.click(copySelectionButton);
      expect(clipboardWrites).toEqual([]);
      expect(lastTerminal?.getSelection()).toBe("");

      visibilityState = "hidden";
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });

      visibilityState = "visible";
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
        window.dispatchEvent(new Event("focus"));
      });

      await waitFor(() => {
        expect(ws.getConnections("/api/ssh-terminal")).toHaveLength(2);
        expect(copySelectionButton).toBeDisabled();
        expect(lastTerminal?.getSelection()).toBe("");
      });
    } finally {
      if (originalVisibilityState) {
        Object.defineProperty(document, "visibilityState", originalVisibilityState);
      } else {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          get: () => "visible",
        });
      }
    }
  });

  test("copies terminal clipboard messages to the browser clipboard", async () => {
    api.get("/api/ssh-sessions/:id", (req) =>
      createSshSession({ config: { id: req.params["id"]!, name: "SSH Clipboard" } }),
    );

    const { getByText } = renderWithUser(
      <SshSessionDetails
        sshSessionId="ssh-clipboard-1"
        onBack={() => {}}
        copyTextToClipboard={async (text) => {
          clipboardWrites.push(text);
        }}
      />,
    );

    await waitFor(() => {
      expect(getByText("SSH Clipboard")).toBeTruthy();
      expect(ws.getConnections("/api/ssh-terminal")).toHaveLength(1);
      expect(lastTerminal).not.toBeNull();
    });

    const terminalConnection = ws.getConnections("/api/ssh-terminal")[0]!;
    await waitFor(() => {
      expect(terminalConnection.isOpen).toBe(true);
    });

    await act(async () => {
      ws.sendEventTo(terminalConnection, {
        type: "terminal.clipboard",
        text: "copied from remote",
      });
    });

    await waitFor(() => {
      expect(clipboardWrites).toEqual(["copied from remote"]);
    });
  });

  test("shows a copy-now fallback when automatic clipboard writes are blocked", async () => {
    api.get("/api/ssh-sessions/:id", (req) =>
      createSshSession({ config: { id: req.params["id"]!, name: "SSH Clipboard Fallback" } }),
    );

    const copyAttempts: string[] = [];
    const { getByLabelText, getByText, queryByTestId, user } = renderWithUser(
      <SshSessionDetails
        sshSessionId="ssh-clipboard-fallback-1"
        onBack={() => {}}
        copyTextToClipboard={async (text) => {
          copyAttempts.push(text);
          if (copyAttempts.length === 1) {
            throw new Error("NotAllowedError: blocked");
          }
          clipboardWrites.push(text);
        }}
      />,
    );

    await waitFor(() => {
      expect(getByText("SSH Clipboard Fallback")).toBeTruthy();
      expect(ws.getConnections("/api/ssh-terminal")).toHaveLength(1);
    });

    const terminalConnection = ws.getConnections("/api/ssh-terminal")[0]!;
    await waitFor(() => {
      expect(terminalConnection.isOpen).toBe(true);
    });

    await act(async () => {
      ws.sendEventTo(terminalConnection, {
        type: "terminal.clipboard",
        text: "copied from remote",
      });
    });

    await waitFor(() => {
      expect(getByLabelText("Pending terminal clipboard text")).toBeTruthy();
      expect(queryByTestId("ssh-terminal-clipboard-fallback")).toBeTruthy();
    });

    await user.click(getByText((content, element) =>
      content === "Copy now" && element?.tagName.toLowerCase() === "button"
    ));

    await waitFor(() => {
      expect(clipboardWrites).toEqual(["copied from remote"]);
      expect(queryByTestId("ssh-terminal-clipboard-fallback")).toBeNull();
    });

    expect(copyAttempts).toEqual(["copied from remote", "copied from remote"]);
  });

  test("enables the touch copy button only when terminal text is selected and copies that selection", async () => {
    api.get("/api/ssh-sessions/:id", (req) =>
      createSshSession({ config: { id: req.params["id"]!, name: "SSH Selected Copy" } }),
    );

    const { getByRole, getByText, user } = renderWithUser(
      <SshSessionDetails
        sshSessionId="ssh-copy-selection-1"
        onBack={() => {}}
        copyTextToClipboard={async (text) => {
          clipboardWrites.push(text);
        }}
      />,
    );

    await waitFor(() => {
      expect(getByText("SSH Selected Copy")).toBeTruthy();
      expect(ws.getConnections("/api/ssh-terminal")).toHaveLength(1);
      expect(lastTerminal).not.toBeNull();
    });

    await user.click(getByText("Touch controls"));

    const copySelectionButton = getByRole("button", { name: "Copy selection" });
    expect(copySelectionButton).toBeDisabled();

    await act(async () => {
      lastTerminal?.setSelection("selected terminal text");
    });

    await waitFor(() => {
      expect(copySelectionButton).not.toBeDisabled();
    });

    await user.click(copySelectionButton);

    await waitFor(() => {
      expect(clipboardWrites).toEqual(["selected terminal text"]);
    });
  });

  test("reuses the clipboard fallback when touch-copying selected terminal text is blocked", async () => {
    api.get("/api/ssh-sessions/:id", (req) =>
      createSshSession({ config: { id: req.params["id"]!, name: "SSH Selected Copy Fallback" } }),
    );

    const copyAttempts: string[] = [];
    const { getByLabelText, getByRole, getByText, queryByTestId, user } = renderWithUser(
      <SshSessionDetails
        sshSessionId="ssh-copy-selection-fallback-1"
        onBack={() => {}}
        copyTextToClipboard={async (text) => {
          copyAttempts.push(text);
          if (copyAttempts.length === 1) {
            throw new Error("NotAllowedError: blocked");
          }
          clipboardWrites.push(text);
        }}
      />,
    );

    await waitFor(() => {
      expect(getByText("SSH Selected Copy Fallback")).toBeTruthy();
      expect(lastTerminal).not.toBeNull();
    });

    await user.click(getByText("Touch controls"));

    await act(async () => {
      lastTerminal?.setSelection("selected terminal fallback text");
    });

    const copySelectionButton = getByRole("button", { name: "Copy selection" });
    await waitFor(() => {
      expect(copySelectionButton).not.toBeDisabled();
    });

    await user.click(copySelectionButton);

    await waitFor(() => {
      expect(getByLabelText("Pending terminal clipboard text")).toBeTruthy();
      expect(queryByTestId("ssh-terminal-clipboard-fallback")).toBeTruthy();
    });

    await user.click(getByText((content, element) =>
      content === "Copy now" && element?.tagName.toLowerCase() === "button"
    ));

    await waitFor(() => {
      expect(clipboardWrites).toEqual(["selected terminal fallback text"]);
      expect(queryByTestId("ssh-terminal-clipboard-fallback")).toBeNull();
    });

    expect(copyAttempts).toEqual([
      "selected terminal fallback text",
      "selected terminal fallback text",
    ]);
  });

  test("shows the clipboard fallback in focus mode when remote clipboard copy is blocked", async () => {
    globalThis.localStorage?.setItem("ralpher-ssh-focus-mode", "true");

    api.get("/api/ssh-sessions/:id", (req) =>
      createSshSession({ config: { id: req.params["id"]!, name: "SSH Focus Clipboard Fallback" } }),
    );

    const copyAttempts: string[] = [];
    const { getByLabelText, getByText, queryByTestId, queryByText, user } = renderWithUser(
      <SshSessionDetails
        sshSessionId="ssh-focus-clipboard-fallback-1"
        onBack={() => {}}
        copyTextToClipboard={async (text) => {
          copyAttempts.push(text);
          if (copyAttempts.length === 1) {
            throw new Error("NotAllowedError: blocked");
          }
          clipboardWrites.push(text);
        }}
      />,
    );

    await waitFor(() => {
      expect(ws.getConnections("/api/ssh-terminal")).toHaveLength(1);
      expect(queryByText("SSH Focus Clipboard Fallback")).toBeNull();
    });

    const terminalConnection = ws.getConnections("/api/ssh-terminal")[0]!;
    await waitFor(() => {
      expect(terminalConnection.isOpen).toBe(true);
    });

    await act(async () => {
      ws.sendEventTo(terminalConnection, {
        type: "terminal.clipboard",
        text: "focus copied from remote",
      });
    });

    await waitFor(() => {
      expect(getByLabelText("Pending terminal clipboard text")).toBeTruthy();
      expect(queryByTestId("ssh-terminal-clipboard-fallback")).toBeTruthy();
    });

    await user.click(getByText((content, element) =>
      content === "Copy now" && element?.tagName.toLowerCase() === "button"
    ));

    await waitFor(() => {
      expect(clipboardWrites).toEqual(["focus copied from remote"]);
      expect(queryByTestId("ssh-terminal-clipboard-fallback")).toBeNull();
    });

    expect(copyAttempts).toEqual(["focus copied from remote", "focus copied from remote"]);
  });

  test("reuses the clipboard fallback when focus-mode copy is blocked", async () => {
    globalThis.localStorage?.setItem("ralpher-ssh-focus-mode", "true");

    api.get("/api/ssh-sessions/:id", (req) =>
      createSshSession({ config: { id: req.params["id"]!, name: "SSH Focus Selected Copy Fallback" } }),
    );

    const copyAttempts: string[] = [];
    const { getByLabelText, getByRole, getByText, queryByTestId, queryByText, user } = renderWithUser(
      <SshSessionDetails
        sshSessionId="ssh-focus-copy-selection-fallback-1"
        onBack={() => {}}
        copyTextToClipboard={async (text) => {
          copyAttempts.push(text);
          if (copyAttempts.length === 1) {
            throw new Error("NotAllowedError: blocked");
          }
          clipboardWrites.push(text);
        }}
      />,
    );

    await waitFor(() => {
      expect(lastTerminal).not.toBeNull();
      expect(queryByText("SSH Focus Selected Copy Fallback")).toBeNull();
    });

    await act(async () => {
      lastTerminal?.setSelection("focus mode selected terminal text");
    });

    const copyButton = getByRole("button", { name: "Copy" });
    await waitFor(() => {
      expect(copyButton).not.toBeDisabled();
    });

    await user.click(copyButton);

    await waitFor(() => {
      expect(getByLabelText("Pending terminal clipboard text")).toBeTruthy();
      expect(queryByTestId("ssh-terminal-clipboard-fallback")).toBeTruthy();
    });

    await user.click(getByText((content, element) =>
      content === "Copy now" && element?.tagName.toLowerCase() === "button"
    ));

    await waitFor(() => {
      expect(clipboardWrites).toEqual(["focus mode selected terminal text"]);
      expect(queryByTestId("ssh-terminal-clipboard-fallback")).toBeNull();
    });

    expect(copyAttempts).toEqual([
      "focus mode selected terminal text",
      "focus mode selected terminal text",
    ]);
  });

  test("connects a standalone SSH session terminal with a stored browser credential", async () => {
    globalThis.localStorage?.setItem("ralpher.sshServerCredential.server-1", JSON.stringify({
      encryptedCredential: {
        algorithm: "RSA-OAEP-256",
        fingerprint: "fp-1",
        version: 1,
        ciphertext: "ciphertext",
      },
      storedAt: new Date().toISOString(),
    }));
    api.get("/api/ssh-server-sessions/:id", (req) => ({
      config: {
        id: req.params["id"]!,
        sshServerId: "server-1",
        name: "Standalone Session",
        connectionMode: "dtach",
        remoteSessionName: "ralpher-standalone-1",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      state: { status: "ready" },
    }));
    api.get("/api/ssh-servers/:id", (req) => ({
      config: {
        id: req.params["id"]!,
        name: "Production Shell",
        address: "ssh.example.com",
        username: "deploy",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      publicKey: {
        algorithm: "RSA-OAEP-256",
        publicKey: TEST_PUBLIC_KEY,
        fingerprint: "fp-1",
        version: 1,
        createdAt: new Date().toISOString(),
      },
    }));
    api.get("/api/ssh-servers/:id/public-key", () => ({
      algorithm: "RSA-OAEP-256",
      publicKey: TEST_PUBLIC_KEY,
      fingerprint: "fp-1",
      version: 1,
      createdAt: new Date().toISOString(),
    }));
    api.post("/api/ssh-servers/:id/credentials", () => ({
      credentialToken: "token-123",
      expiresAt: new Date().toISOString(),
    }));

    const { getByText, user } = renderWithUser(
      <SshSessionDetails sshSessionId="standalone-ssh-1" onBack={() => {}} />,
    );

    await waitFor(() => {
      expect(getByText("Standalone Session")).toBeTruthy();
      expect(ws.getConnections("/api/ssh-terminal")).toHaveLength(1);
    });

    const terminalConnection = ws.getConnections("/api/ssh-terminal")[0]!;
    expect(terminalConnection.queryParams["sshServerSessionId"]).toBe("standalone-ssh-1");
    expect(terminalConnection.queryParams["credentialToken"]).toBeUndefined();
    expect(terminalConnection.sentMessages).toContain(
      JSON.stringify({ type: "terminal.auth", credentialToken: "token-123" }),
    );

    await user.click(getByText("Session Info"));
    await waitFor(() => {
      expect(getByText("Server")).toBeTruthy();
      expect(getByText("Production Shell")).toBeTruthy();
      expect(getByText("deploy@ssh.example.com")).toBeTruthy();
    });
  });

  test("refreshes the standalone SSH credential token when focus recovery reconnects the terminal", async () => {
    globalThis.localStorage?.setItem("ralpher.sshServerCredential.server-1", JSON.stringify({
      encryptedCredential: {
        algorithm: "RSA-OAEP-256",
        fingerprint: "fp-1",
        version: 1,
        ciphertext: "ciphertext",
      },
      storedAt: new Date().toISOString(),
    }));
    api.get("/api/ssh-server-sessions/:id", (req) => ({
      config: {
        id: req.params["id"]!,
        sshServerId: "server-1",
        name: "Standalone Focus Recovery",
        connectionMode: "dtach",
        remoteSessionName: "ralpher-standalone-focus",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      state: { status: "ready" },
    }));
    api.get("/api/ssh-servers/:id", (req) => ({
      config: {
        id: req.params["id"]!,
        name: "Recovery Shell",
        address: "focus.example.com",
        username: "deploy",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      publicKey: {
        algorithm: "RSA-OAEP-256",
        publicKey: TEST_PUBLIC_KEY,
        fingerprint: "fp-1",
        version: 1,
        createdAt: new Date().toISOString(),
      },
    }));
    api.get("/api/ssh-servers/:id/public-key", () => ({
      algorithm: "RSA-OAEP-256",
      publicKey: TEST_PUBLIC_KEY,
      fingerprint: "fp-1",
      version: 1,
      createdAt: new Date().toISOString(),
    }));

    let credentialExchangeCount = 0;
    api.post("/api/ssh-servers/:id/credentials", () => {
      credentialExchangeCount += 1;
      return {
        credentialToken: `token-${credentialExchangeCount}`,
        expiresAt: new Date().toISOString(),
      };
    });

    let visibilityState = "visible";
    const originalVisibilityState = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibilityState,
    });

    try {
      const { getByText } = renderWithUser(
        <SshSessionDetails sshSessionId="standalone-ssh-focus" onBack={() => {}} />,
      );

      await waitFor(() => {
        expect(getByText("Standalone Focus Recovery")).toBeTruthy();
        expect(api.calls("/api/ssh-servers/:id/credentials", "POST")).toHaveLength(1);
        expect(ws.getConnections("/api/ssh-terminal")).toHaveLength(1);
      });

      const initialConnection = ws.getConnections("/api/ssh-terminal")[0]!;
      expect(initialConnection.sentMessages).toContain(
        JSON.stringify({ type: "terminal.auth", credentialToken: "token-1" }),
      );

      await act(async () => {
        initialConnection.instance.close(1006, "network lost");
      });

      await waitFor(() => {
        expect(getByText("disconnected")).toBeTruthy();
      });

      visibilityState = "hidden";
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });

      visibilityState = "visible";
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
        window.dispatchEvent(new Event("focus"));
      });

      await waitFor(() => {
        expect(api.calls("/api/ssh-servers/:id/credentials", "POST")).toHaveLength(2);
        expect(ws.getConnections("/api/ssh-terminal")).toHaveLength(2);
      });

      const recoveredConnections = ws.getConnections("/api/ssh-terminal");
      const recoveredConnection = recoveredConnections[recoveredConnections.length - 1]!;
      expect(recoveredConnection).not.toBe(initialConnection);
      expect(recoveredConnection.sentMessages).toContain(
        JSON.stringify({ type: "terminal.auth", credentialToken: "token-2" }),
      );
    } finally {
      if (originalVisibilityState) {
        Object.defineProperty(document, "visibilityState", originalVisibilityState);
      } else {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          get: () => "visible",
        });
      }
    }
  });

  test("shows the standalone password prompt when credential refresh throws during focus recovery", async () => {
    globalThis.localStorage?.setItem("ralpher.sshServerCredential.server-1", JSON.stringify({
      encryptedCredential: {
        algorithm: "RSA-OAEP-256",
        fingerprint: "fp-1",
        version: 1,
        ciphertext: "ciphertext",
      },
      storedAt: new Date().toISOString(),
    }));
    api.get("/api/ssh-server-sessions/:id", (req) => ({
      config: {
        id: req.params["id"]!,
        sshServerId: "server-1",
        name: "Standalone Focus Refresh Failure",
        connectionMode: "dtach",
        remoteSessionName: "ralpher-standalone-refresh-failure",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      state: { status: "ready" },
    }));
    api.get("/api/ssh-servers/:id", (req) => ({
      config: {
        id: req.params["id"]!,
        name: "Refresh Failure Host",
        address: "refresh-failure.example.com",
        username: "deploy",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      publicKey: {
        algorithm: "RSA-OAEP-256",
        publicKey: TEST_PUBLIC_KEY,
        fingerprint: "fp-1",
        version: 1,
        createdAt: new Date().toISOString(),
      },
    }));

    let publicKeyFetchCount = 0;
    api.get("/api/ssh-servers/:id/public-key", () => {
      publicKeyFetchCount += 1;
      if (publicKeyFetchCount === 1) {
        return {
          algorithm: "RSA-OAEP-256",
          publicKey: TEST_PUBLIC_KEY,
          fingerprint: "fp-1",
          version: 1,
          createdAt: new Date().toISOString(),
        };
      }
      throw new Error("Public key refresh failed");
    });
    api.post("/api/ssh-servers/:id/credentials", () => ({
      credentialToken: "token-1",
      expiresAt: new Date().toISOString(),
    }));

    let visibilityState = "visible";
    const originalVisibilityState = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibilityState,
    });

    try {
      const { getByRole, getByText } = renderWithUser(
        <SshSessionDetails sshSessionId="standalone-ssh-refresh-failure" onBack={() => {}} />,
      );

      await waitFor(() => {
        expect(getByText("Standalone Focus Refresh Failure")).toBeTruthy();
        expect(api.calls("/api/ssh-servers/:id/public-key", "GET")).toHaveLength(1);
        expect(api.calls("/api/ssh-servers/:id/credentials", "POST")).toHaveLength(1);
        expect(ws.getConnections("/api/ssh-terminal")).toHaveLength(1);
      });

      const initialConnection = ws.getConnections("/api/ssh-terminal")[0]!;
      await act(async () => {
        initialConnection.instance.close(1006, "network lost");
      });

      await waitFor(() => {
        expect(getByText("disconnected")).toBeTruthy();
      });

      visibilityState = "hidden";
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });

      visibilityState = "visible";
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
        window.dispatchEvent(new Event("focus"));
      });

      await waitFor(() => {
        expect(api.calls("/api/ssh-servers/:id/public-key", "GET")).toHaveLength(2);
        expect(api.calls("/api/ssh-servers/:id/credentials", "POST")).toHaveLength(1);
        expect(ws.getConnections("/api/ssh-terminal")).toHaveLength(1);
        expect(getByText("SSH password required")).toBeTruthy();
        expect(getByRole("alert").textContent).toContain(
          "Failed to refresh the stored SSH credential: Error: Failed to fetch SSH server public key for server-1",
        );
      });
    } finally {
      if (originalVisibilityState) {
        Object.defineProperty(document, "visibilityState", originalVisibilityState);
      } else {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          get: () => "visible",
        });
      }
    }
  });

  test("does not re-probe the workspace endpoint or remint standalone terminal credentials on session refresh", async () => {
    let standaloneStatus = "ready";

    globalThis.localStorage?.setItem("ralpher.sshServerCredential.server-1", JSON.stringify({
      encryptedCredential: {
        algorithm: "RSA-OAEP-256",
        fingerprint: "fp-1",
        version: 1,
        ciphertext: "ciphertext",
      },
      storedAt: new Date().toISOString(),
    }));

    api.get("/api/ssh-sessions/:id", () => ({
      error: "not_found",
      message: "SSH session not found",
    }), 404);
    api.get("/api/ssh-server-sessions/:id", (req) => ({
      config: {
        id: req.params["id"]!,
        sshServerId: "server-1",
        name: "Refresh Stable Session",
        connectionMode: "dtach",
        remoteSessionName: "ralpher-standalone-refresh",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      state: { status: standaloneStatus },
    }));
    api.get("/api/ssh-servers/:id", (req) => ({
      config: {
        id: req.params["id"]!,
        name: "Refresh Host",
        address: "refresh.example.com",
        username: "ops",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      publicKey: {
        algorithm: "RSA-OAEP-256",
        publicKey: TEST_PUBLIC_KEY,
        fingerprint: "fp-1",
        version: 1,
        createdAt: new Date().toISOString(),
      },
    }));
    api.get("/api/ssh-servers/:id/public-key", () => ({
      algorithm: "RSA-OAEP-256",
      publicKey: TEST_PUBLIC_KEY,
      fingerprint: "fp-1",
      version: 1,
      createdAt: new Date().toISOString(),
    }));
    api.post("/api/ssh-servers/:id/credentials", () => ({
      credentialToken: "token-123",
      expiresAt: new Date().toISOString(),
    }));

    const { getByText } = renderWithUser(
      <SshSessionDetails sshSessionId="standalone-ssh-refresh" onBack={() => {}} />,
    );

    await waitFor(() => {
      expect(getByText("Refresh Stable Session")).toBeTruthy();
      expect(api.calls("/api/ssh-sessions/:id", "GET")).toHaveLength(1);
      expect(api.calls("/api/ssh-server-sessions/:id", "GET")).toHaveLength(1);
      expect(api.calls("/api/ssh-servers/:id", "GET")).toHaveLength(1);
      expect(api.calls("/api/ssh-servers/:id/public-key", "GET")).toHaveLength(1);
      expect(api.calls("/api/ssh-servers/:id/credentials", "POST")).toHaveLength(1);
      expect(ws.getConnections("/api/ws")).toHaveLength(1);
      expect(ws.getConnections("/api/ssh-terminal")).toHaveLength(1);
    });

    standaloneStatus = "connected";
    const sessionConnection = ws.getConnections("/api/ws")[0]!;

    await act(async () => {
      ws.sendEventTo(sessionConnection, {
        type: "ssh_session.status",
        sshSessionId: "standalone-ssh-refresh",
        status: "connected",
      });
    });

    await waitFor(() => {
      expect(api.calls("/api/ssh-server-sessions/:id", "GET")).toHaveLength(2);
    });

    expect(api.calls("/api/ssh-sessions/:id", "GET")).toHaveLength(1);
    expect(api.calls("/api/ssh-servers/:id/public-key", "GET")).toHaveLength(1);
    expect(api.calls("/api/ssh-servers/:id", "GET")).toHaveLength(1);
    expect(api.calls("/api/ssh-servers/:id/credentials", "POST")).toHaveLength(1);
    expect(ws.getConnections("/api/ws")).toHaveLength(1);
    expect(ws.getConnections("/api/ssh-terminal")).toHaveLength(1);
    expect(ws.getConnections("/api/ssh-terminal")[0]?.queryParams["credentialToken"]).toBeUndefined();
    expect(ws.getConnections("/api/ssh-terminal")[0]?.sentMessages).toContain(
      JSON.stringify({ type: "terminal.auth", credentialToken: "token-123" }),
    );
  });

  test("prompts for a standalone SSH password when no browser credential is stored", async () => {
    api.get("/api/ssh-server-sessions/:id", (req) => ({
      config: {
        id: req.params["id"]!,
        sshServerId: "server-1",
        name: "Password Prompt Session",
        connectionMode: "dtach",
        remoteSessionName: "ralpher-standalone-2",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      state: { status: "ready" },
    }));
    api.get("/api/ssh-servers/:id", (req) => ({
      config: {
        id: req.params["id"]!,
        name: "Password Prompt Host",
        address: "password.example.com",
        username: "admin",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      publicKey: {
        algorithm: "RSA-OAEP-256",
        publicKey: TEST_PUBLIC_KEY,
        fingerprint: "fp-1",
        version: 1,
        createdAt: new Date().toISOString(),
      },
    }));
    api.get("/api/ssh-servers/:id/public-key", () => ({
      algorithm: "RSA-OAEP-256",
      publicKey: TEST_PUBLIC_KEY,
      fingerprint: "fp-1",
      version: 1,
      createdAt: new Date().toISOString(),
    }));
    let credentialServerId = "";
    api.post("/api/ssh-servers/:id/credentials", (req) => {
      credentialServerId = req.params["id"] ?? "";
      return {
        credentialToken: "token-456",
        expiresAt: new Date().toISOString(),
      };
    });

    const { getByLabelText, getByText, queryByText, user } = renderWithUser(
      <SshSessionDetails sshSessionId="standalone-ssh-2" onBack={() => {}} />,
    );

    await waitFor(() => {
      expect(getByText("Password Prompt Session")).toBeTruthy();
      expect(getByText("SSH password required")).toBeTruthy();
    });

    const passwordInput = getByLabelText("SSH password") as HTMLInputElement;
    expect(passwordInput.autocomplete).toBe("off");
    expect(passwordInput.getAttribute("autocapitalize")).toBe("off");
    expect(passwordInput.getAttribute("autocorrect")).toBe("off");
    expect(passwordInput.getAttribute("data-1p-ignore")).toBe("true");
    expect(passwordInput.getAttribute("data-bwignore")).toBe("true");
    expect(passwordInput.getAttribute("data-form-type")).toBe("other");
    expect(passwordInput.getAttribute("data-lpignore")).toBe("true");
    expect(passwordInput.getAttribute("spellcheck")).toBe("false");

    expect(ws.getConnections("/api/ssh-terminal")).toHaveLength(0);

    await user.type(passwordInput, "secret");
    await user.click(getByText("Continue"));

    await waitFor(() => {
      expect(queryByText("SSH password required")).toBeNull();
      expect(api.calls("/api/ssh-servers/:id/credentials", "POST")).toHaveLength(1);
      expect(globalThis.localStorage?.getItem("ralpher.sshServerCredential.server-1")).toBeTruthy();
    });

    expect(credentialServerId).toBe("server-1");
  });

  test("keeps the standalone password prompt open and shows a toast when password submission fails", async () => {
    api.get("/api/ssh-server-sessions/:id", (req) => ({
      config: {
        id: req.params["id"]!,
        sshServerId: "server-1",
        name: "Password Failure Session",
        connectionMode: "dtach",
        remoteSessionName: "ralpher-standalone-failure",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      state: { status: "ready" },
    }));
    api.get("/api/ssh-servers/:id", (req) => ({
      config: {
        id: req.params["id"]!,
        name: "Failure Host",
        address: "failure.example.com",
        username: "admin",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      publicKey: {
        algorithm: "RSA-OAEP-256",
        publicKey: TEST_PUBLIC_KEY,
        fingerprint: "fp-1",
        version: 1,
        createdAt: new Date().toISOString(),
      },
    }));
    api.get("/api/ssh-servers/:id/public-key", () => ({
      algorithm: "RSA-OAEP-256",
      publicKey: TEST_PUBLIC_KEY,
      fingerprint: "fp-1",
      version: 1,
      createdAt: new Date().toISOString(),
    }));
    api.post("/api/ssh-servers/:id/credentials", () => ({
      message: "Credential exchange exploded",
    }), 500);

    const { getByLabelText, getByText, user } = renderWithUser(
      <SshSessionDetails sshSessionId="standalone-ssh-failure" onBack={() => {}} />,
    );

    await waitFor(() => {
      expect(getByText("Password Failure Session")).toBeTruthy();
      expect(getByText("SSH password required")).toBeTruthy();
    });

    await user.type(getByLabelText("SSH password"), "secret");
    await user.click(getByText("Continue"));

    await waitFor(() => {
      expect(getByText("SSH password required")).toBeTruthy();
      expect(getByText(/Credential exchange exploded/)).toBeTruthy();
    });

    expect(ws.getConnections("/api/ssh-terminal")).toHaveLength(0);
  });

  test("shows focus mode toggle in touch controls and enters focus mode on click", async () => {
    // Clear the explicit "false" set in beforeEach to test the real default (focus mode ON)
    globalThis.localStorage?.removeItem("ralpher-ssh-focus-mode");

    api.get("/api/ssh-sessions/:id", (req) =>
      createSshSession({ config: { id: req.params["id"]!, name: "Focus Mode Test" } }),
    );

    const { getByText, getByLabelText, queryByText, user } = renderWithUser(
      <SshSessionDetails sshSessionId="ssh-focus-1" onBack={() => {}} />,
    );

    await waitFor(() => {
      expect(ws.getConnections("/api/ssh-terminal")).toHaveLength(1);
      expect(lastTerminal).not.toBeNull();
    });

    // Default is focus mode: header, session info, and touch controls should be hidden
    await waitFor(() => {
      expect(queryByText("Focus Mode Test")).toBeNull();
      expect(queryByText("Session Info")).toBeNull();
      expect(queryByText("Touch controls")).toBeNull();
    });

    // The FocusModeBar should be visible with an exit button and arrow buttons
    const exitButton = getByLabelText("Exit focus mode");
    expect(exitButton).toBeTruthy();
    expect(getByLabelText("Arrow left")).toBeTruthy();
    expect(getByLabelText("Arrow up")).toBeTruthy();
    expect(getByLabelText("Arrow down")).toBeTruthy();
    expect(getByLabelText("Arrow right")).toBeTruthy();
    expect(getByLabelText("Enter")).toBeTruthy();
    expect(getByLabelText("Space")).toBeTruthy();

    // Exit focus mode — normal view should be restored with the "Enter focus mode" button
    await user.click(exitButton);

    await waitFor(() => {
      expect(getByText("Focus Mode Test")).toBeTruthy();
      expect(getByText("Session Info")).toBeTruthy();
      expect(getByText("Touch controls")).toBeTruthy();
    });

    // The focus mode toggle button should be visible in the touch controls summary
    const focusButton = getByLabelText("Enter focus mode");
    expect(focusButton).toBeTruthy();

    // Click to re-enter focus mode
    await user.click(focusButton);

    // In focus mode again: header, session info, and touch controls should be hidden
    await waitFor(() => {
      expect(queryByText("Focus Mode Test")).toBeNull();
      expect(queryByText("Session Info")).toBeNull();
      expect(queryByText("Touch controls")).toBeNull();
    });
  });

  test("prevents focus-mode controls from taking focus on press", async () => {
    globalThis.localStorage?.removeItem("ralpher-ssh-focus-mode");

    api.get("/api/ssh-sessions/:id", (req) =>
      createSshSession({ config: { id: req.params["id"]!, name: "Focus Keyboard Stability" } }),
    );

    const { getByLabelText } = renderWithUser(
      <SshSessionDetails sshSessionId="ssh-focus-preserve-keyboard" onBack={() => {}} />,
    );

    await waitFor(() => {
      expect(lastTerminal).not.toBeNull();
    });

    const arrowLeftButton = getByLabelText("Arrow left");
    const enterButton = getByLabelText("Enter");

    const arrowLeftMouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    const enterMouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });

    expect(arrowLeftButton.dispatchEvent(arrowLeftMouseDown)).toBe(false);
    expect(arrowLeftMouseDown.defaultPrevented).toBe(true);
    expect(enterButton.dispatchEvent(enterMouseDown)).toBe(false);
    expect(enterMouseDown.defaultPrevented).toBe(true);
  });

  test("exits focus mode and restores normal view", async () => {
    // Clear the explicit "false" set in beforeEach to test the real default (focus mode ON)
    globalThis.localStorage?.removeItem("ralpher-ssh-focus-mode");

    api.get("/api/ssh-sessions/:id", (req) =>
      createSshSession({ config: { id: req.params["id"]!, name: "Focus Exit Test" } }),
    );

    const { getByText, getByLabelText, queryByText, user } = renderWithUser(
      <SshSessionDetails sshSessionId="ssh-focus-2" onBack={() => {}} />,
    );

    await waitFor(() => {
      expect(lastTerminal).not.toBeNull();
    });

    // Default is focus mode: header should be hidden
    await waitFor(() => {
      expect(queryByText("Focus Exit Test")).toBeNull();
    });

    // Exit focus mode
    await user.click(getByLabelText("Exit focus mode"));

    // Normal view should be restored
    await waitFor(() => {
      expect(getByText("Focus Exit Test")).toBeTruthy();
      expect(getByText("Session Info")).toBeTruthy();
      expect(getByText("Touch controls")).toBeTruthy();
    });
  });

  test("persists focus mode preference across renders via localStorage", async () => {
    // Clear the explicit "false" set in beforeEach to test the real default (focus mode ON)
    globalThis.localStorage?.removeItem("ralpher-ssh-focus-mode");

    api.get("/api/ssh-sessions/:id", (req) =>
      createSshSession({ config: { id: req.params["id"]!, name: "Focus Persist" } }),
    );

    const { queryByText, getByLabelText, user, unmount } = renderWithUser(
      <SshSessionDetails sshSessionId="ssh-focus-3" onBack={() => {}} />,
    );

    await waitFor(() => {
      expect(lastTerminal).not.toBeNull();
    });

    // Default is focus mode — exit it (which persists "false" to localStorage)
    await waitFor(() => {
      expect(queryByText("Focus Persist")).toBeNull();
    });
    await user.click(getByLabelText("Exit focus mode"));
    await waitFor(() => {
      expect(queryByText("Focus Persist")).not.toBeNull();
    });

    expect(localStorage.getItem("ralpher-ssh-focus-mode")).toBe("false");

    // Unmount and re-render — should start in normal mode (preference was persisted)
    unmount();
    resetGhosttyWebMockState();

    const { queryByText: queryByText2, getByText: getByText2 } = renderWithUser(
      <SshSessionDetails sshSessionId="ssh-focus-3" onBack={() => {}} />,
    );

    await waitFor(() => {
      expect(lastTerminal).not.toBeNull();
    });

    // Should be in normal mode (header visible, no exit button in FocusModeBar)
    await waitFor(() => {
      expect(getByText2("Focus Persist")).toBeTruthy();
      expect(queryByText2("Session Info")).not.toBeNull();
    });
  });

  test("keeps the terminal container mounted when toggling focus mode", async () => {
    // Clear the explicit "false" set in beforeEach to test the real default (focus mode ON)
    globalThis.localStorage?.removeItem("ralpher-ssh-focus-mode");

    api.get("/api/ssh-sessions/:id", (req) =>
      createSshSession({ config: { id: req.params["id"]!, name: "Focus Terminal" } }),
    );

    const { getByLabelText, user } = renderWithUser(
      <SshSessionDetails sshSessionId="ssh-focus-4" onBack={() => {}} />,
    );

    await waitFor(() => {
      expect(lastTerminal).not.toBeNull();
    });

    const terminalBeforeToggle = lastTerminal;

    // Exit focus mode (default is focus mode ON)
    await user.click(getByLabelText("Exit focus mode"));

    // The terminal instance should be the same (not disposed and re-created)
    expect(lastTerminal).toBe(terminalBeforeToggle);
    expect(lastTerminal!.element).not.toBeNull();

    // Re-enter focus mode
    await user.click(getByLabelText("Enter focus mode"));

    // Still the same terminal instance
    expect(lastTerminal).toBe(terminalBeforeToggle);
    expect(lastTerminal!.element).not.toBeNull();
  });

  test("constrains the forced focus terminal layout to the terminal container", async () => {
    api.get("/api/ssh-sessions/:id", (req) =>
      createSshSession({ config: { id: req.params["id"]!, name: "Embedded Focus Terminal" } }),
    );

    const addViewportListener = mock(() => {});
    const removeViewportListener = mock(() => {});
    const originalVisualViewport = window.visualViewport;
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: {
        height: 777,
        offsetTop: 19,
        addEventListener: addViewportListener,
        removeEventListener: removeViewportListener,
      },
    });

    const { container, unmount } = renderWithUser(
      <div className="flex h-[480px] min-h-0 flex-col overflow-hidden">
        <SshSessionDetails sshSessionId="ssh-focus-embedded" forcedFocusMode={true} />
      </div>,
    );

    try {
      await waitFor(() => {
        expect(lastTerminal).not.toBeNull();
        expect(lastTerminal?.canvas).not.toBeNull();
      });

      const terminalContainer = lastTerminal!.canvas!.parentElement;
      expect(terminalContainer).not.toBeNull();

      const terminalWrapper = terminalContainer!.parentElement;
      expect(terminalWrapper).not.toBeNull();
      expect(terminalWrapper!.className).toContain("overflow-hidden");

      const mainContent = terminalWrapper!.parentElement;
      expect(mainContent).not.toBeNull();
      expect(mainContent!.className).toContain("overflow-hidden");

      const embeddedRoot = container.firstElementChild?.firstElementChild;
      expect(embeddedRoot).toBeInstanceOf(HTMLDivElement);
      expect((embeddedRoot as HTMLDivElement).style.height).toBe("");
      expect((embeddedRoot as HTMLDivElement).style.transform).toBe("");
      expect(addViewportListener).not.toHaveBeenCalled();
      expect(removeViewportListener).not.toHaveBeenCalled();
    } finally {
      unmount();
      if (originalVisualViewport === undefined) {
        Reflect.deleteProperty(window, "visualViewport");
      } else {
        Object.defineProperty(window, "visualViewport", {
          configurable: true,
          value: originalVisualViewport,
        });
      }
    }
  });
});
