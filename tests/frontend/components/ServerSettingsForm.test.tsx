/**
 * Tests for the ServerSettingsForm component.
 */

import { describe, test, expect, mock } from "bun:test";
import { ServerSettingsForm } from "@/components/ServerSettingsForm";
import { renderWithUser, waitFor } from "../helpers/render";

const registeredSshServers = [
  {
    config: {
      id: "server-1",
      name: "Build Box",
      address: "10.0.0.5",
      username: "vscode",
      repositoriesBasePath: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    publicKey: {
      algorithm: "RSA-OAEP-256" as const,
      publicKey: "public-key-1",
      fingerprint: "fingerprint-1",
      version: 1,
      createdAt: new Date().toISOString(),
    },
  },
  {
    config: {
      id: "server-2",
      name: "Staging",
      address: "10.0.0.6",
      username: "deploy",
      repositoriesBasePath: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    publicKey: {
      algorithm: "RSA-OAEP-256" as const,
      publicKey: "public-key-2",
      fingerprint: "fingerprint-2",
      version: 1,
      createdAt: new Date().toISOString(),
    },
  },
];

describe("ServerSettingsForm", () => {
  test("emits stdio settings by default without legacy fields", async () => {
    const onChange = mock();
    const { queryByLabelText } = renderWithUser(
      <ServerSettingsForm onChange={onChange} />
    );

    await waitFor(() => {
      expect(onChange).toHaveBeenCalled();
    });

    const [settings, isValid] = onChange.mock.calls.at(-1) as [
      { agent: { provider: string; transport: string } },
      boolean,
    ];

    expect(settings).toEqual({
      agent: {
        provider: "opencode",
        transport: "stdio",
      },
    });
    expect(isValid).toBe(true);
    expect(queryByLabelText("Hostname")).not.toBeInTheDocument();
    expect(queryByLabelText("Port")).not.toBeInTheDocument();
  });

  test("shows SSH fields and emits SSH settings when transport changes", async () => {
    const onChange = mock();
    const { getByLabelText, user } = renderWithUser(
      <ServerSettingsForm onChange={onChange} />
    );

    const transportSelect = getByLabelText("Transport") as HTMLSelectElement;
    await user.selectOptions(transportSelect, "ssh");

    const hostInput = getByLabelText("Hostname") as HTMLInputElement;
    const portInput = getByLabelText("Port") as HTMLInputElement;
    const userInput = getByLabelText("Username (optional)") as HTMLInputElement;
    const passInput = getByLabelText("Password (optional)") as HTMLInputElement;

    expect(passInput.autocomplete).toBe("off");
    expect(passInput.getAttribute("autocapitalize")).toBe("off");
    expect(passInput.getAttribute("autocorrect")).toBe("off");
    expect(passInput.getAttribute("data-1p-ignore")).toBe("true");
    expect(passInput.getAttribute("data-bwignore")).toBe("true");
    expect(passInput.getAttribute("data-form-type")).toBe("other");
    expect(passInput.getAttribute("data-lpignore")).toBe("true");
    expect(passInput.getAttribute("spellcheck")).toBe("false");

    await user.clear(hostInput);
    await user.type(hostInput, "remote-host");
    await user.clear(portInput);
    await user.type(portInput, "2222");
    await user.type(userInput, "vscode");
    await user.type(passInput, "secret");

    const [settings, isValid] = onChange.mock.calls.at(-1) as [
      {
        agent: {
          provider: string;
          transport: string;
          hostname: string;
          port: number;
          username?: string;
          password?: string;
        };
      },
      boolean,
    ];

    expect(settings).toEqual({
      agent: {
        provider: "opencode",
        transport: "ssh",
        hostname: "remote-host",
        port: 2222,
        username: "vscode",
        password: "secret",
      },
    });
    expect(isValid).toBe(true);
  });

  test("remoteOnly defaults to ssh and disables stdio option", async () => {
    const onChange = mock();
    const { getByLabelText } = renderWithUser(
      <ServerSettingsForm onChange={onChange} remoteOnly={true} />
    );

    await waitFor(() => {
      expect(onChange).toHaveBeenCalled();
    });

    const transportSelect = getByLabelText("Transport") as HTMLSelectElement;
    const stdioOption = Array.from(transportSelect.options).find((opt) => opt.value === "stdio");
    expect(transportSelect.value).toBe("ssh");
    expect(stdioOption?.disabled).toBe(true);

    const [settings] = onChange.mock.calls.at(-1) as [
      {
        agent: {
          provider: string;
          transport: string;
          hostname?: string;
          port?: number;
        };
      },
    ];
    expect(settings.agent.transport).toBe("ssh");
    expect(settings.agent.hostname).toBe("localhost");
    expect(settings.agent.port).toBe(22);
  });

  test("selecting a registered SSH server emits its address as hostname", async () => {
    const onChange = mock();
    const { getByLabelText, queryByLabelText, user } = renderWithUser(
      <ServerSettingsForm
        onChange={onChange}
        remoteOnly={true}
        registeredSshServers={registeredSshServers}
      />
    );

    await waitFor(() => {
      expect(onChange).toHaveBeenCalled();
    });

    const serverSelect = getByLabelText("Server") as HTMLSelectElement;
    expect(serverSelect.value).toBe("__other__");
    expect(getByLabelText("Hostname")).toBeTruthy();

    await user.selectOptions(serverSelect, "server-1");

    expect(queryByLabelText("Hostname")).not.toBeInTheDocument();

    const [settings, isValid] = onChange.mock.calls.at(-1) as [
      {
        agent: {
          transport: string;
          hostname?: string;
          port?: number;
        };
      },
      boolean,
    ];

    expect(settings.agent.transport).toBe("ssh");
    expect(settings.agent.hostname).toBe("10.0.0.5");
    expect(settings.agent.port).toBe(22);
    expect(isValid).toBe(true);
  });

  test("selecting Other reveals manual hostname entry and preserves manual edits", async () => {
    const onChange = mock();
    const { getByLabelText, user } = renderWithUser(
      <ServerSettingsForm
        onChange={onChange}
        remoteOnly={true}
        registeredSshServers={registeredSshServers}
      />
    );

    const serverSelect = getByLabelText("Server") as HTMLSelectElement;
    await user.selectOptions(serverSelect, "server-2");
    await user.selectOptions(serverSelect, "__other__");

    const hostInput = getByLabelText("Hostname") as HTMLInputElement;
    await user.clear(hostInput);
    await user.type(hostInput, "manual-host");

    const [settings, isValid] = onChange.mock.calls.at(-1) as [
      {
        agent: {
          transport: string;
          hostname?: string;
        };
      },
      boolean,
    ];

    expect(settings.agent.transport).toBe("ssh");
    expect(settings.agent.hostname).toBe("manual-host");
    expect(isValid).toBe(true);
  });
});
