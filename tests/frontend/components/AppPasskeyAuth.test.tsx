import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { App } from "@/App";
import { createMockApi } from "../helpers/mock-api";
import { createMockWebSocket } from "../helpers/mock-websocket";
import { renderWithUser, waitFor, within } from "../helpers/render";

const api = createMockApi();
const ws = createMockWebSocket();

const originalPublicKeyCredential = globalThis.PublicKeyCredential;
const originalNavigatorCredentials = navigator.credentials;

interface PasskeyAuthState {
  passkeyConfigured: boolean;
  passkeyDisabled: boolean;
  passkeyRequired: boolean;
  authenticated: boolean;
  basicAuthEnabled?: boolean;
}

function buffer(bytes: number[]): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

function installWebAuthnMocks(options: {
  createResult?: Credential | null;
  getResult?: Credential | null;
}) {
  class MockPublicKeyCredential {}

  Object.defineProperty(globalThis, "PublicKeyCredential", {
    configurable: true,
    writable: true,
    value: MockPublicKeyCredential,
  });

  Object.defineProperty(window, "PublicKeyCredential", {
    configurable: true,
    writable: true,
    value: MockPublicKeyCredential,
  });

  Object.defineProperty(navigator, "credentials", {
    configurable: true,
    value: {
      create: async () => options.createResult ?? null,
      get: async () => options.getResult ?? null,
    },
  });
}

function createRegistrationCredential(): Credential {
  return {
    id: "credential-id",
    rawId: buffer([1, 2, 3]),
    type: "public-key",
    response: {
      attestationObject: buffer([4, 5, 6]),
      clientDataJSON: buffer([7, 8, 9]),
      getTransports: () => ["internal"],
      getPublicKeyAlgorithm: () => -7,
      getPublicKey: () => buffer([10, 11]),
      getAuthenticatorData: () => buffer([12, 13]),
    },
    getClientExtensionResults: () => ({}),
    authenticatorAttachment: "platform",
  } as unknown as Credential;
}

function createAuthenticationCredential(): Credential {
  return {
    id: "credential-id",
    rawId: buffer([1, 2, 3]),
    type: "public-key",
    response: {
      authenticatorData: buffer([4, 5]),
      clientDataJSON: buffer([6, 7]),
      signature: buffer([8, 9]),
      userHandle: null,
    },
    getClientExtensionResults: () => ({}),
    authenticatorAttachment: "platform",
  } as unknown as Credential;
}

function setupDefaultApi(authState: PasskeyAuthState) {
  api.get("/api/config", () => ({
    remoteOnly: false,
    basicAuthEnabled: Boolean(authState.basicAuthEnabled),
    passkeyAuth: {
      passkeyConfigured: authState.passkeyConfigured,
      passkeyDisabled: authState.passkeyDisabled,
      passkeyRequired: authState.passkeyRequired,
      authenticated: authState.authenticated,
    },
  }));
  api.get("/api/health", () => ({ status: "ok", version: "1.0.0" }));
  api.get("/api/loops", () => []);
  api.get("/api/chats", () => []);
  api.get("/api/workspaces", () => []);
  api.get("/api/ssh-sessions", () => []);
  api.get("/api/ssh-servers", () => []);
}

describe("App passkey auth", () => {
  beforeEach(() => {
    api.reset();
    api.install();
    ws.reset();
    ws.install();
    window.location.hash = "";
  });

  afterEach(() => {
    api.uninstall();
    ws.uninstall();
    window.location.hash = "";
    Object.defineProperty(globalThis, "PublicKeyCredential", {
      configurable: true,
      writable: true,
      value: originalPublicKeyCredential,
    });
    Object.defineProperty(window, "PublicKeyCredential", {
      configurable: true,
      writable: true,
      value: originalPublicKeyCredential,
    });
    Object.defineProperty(navigator, "credentials", {
      configurable: true,
      value: originalNavigatorCredentials,
    });
  });

  test("shows the passkey gate and unlocks after a successful login", async () => {
    const authState: PasskeyAuthState = {
      passkeyConfigured: true,
      passkeyDisabled: false,
      passkeyRequired: true,
      authenticated: false,
    };

    setupDefaultApi(authState);
    installWebAuthnMocks({
      getResult: createAuthenticationCredential(),
    });

    api.get("/api/passkey-auth/authentication/options", () => ({
      challenge: "AQID",
      rpId: "example.test",
      allowCredentials: [{ id: "AQID", type: "public-key" }],
      userVerification: "preferred",
    }));
    api.post("/api/passkey-auth/authentication/verify", () => {
      authState.authenticated = true;
      return { success: true };
    }, 200);

    const { user, getByRole, queryByRole } = renderWithUser(<App />);

    await waitFor(() => {
      expect(getByRole("heading", { name: "Unlock Ralpher" })).toBeTruthy();
    });

    await user.click(getByRole("button", { name: "Continue with passkey" }));

    await waitFor(() => {
      expect(getByRole("heading", { name: "Ralpher" })).toBeTruthy();
      expect(queryByRole("heading", { name: "Unlock Ralpher" })).toBeNull();
    });

    expect(api.calls("/api/passkey-auth/authentication/options", "GET")).toHaveLength(1);
    expect(api.calls("/api/passkey-auth/authentication/verify", "POST")).toHaveLength(1);
  });

  test("registers a passkey from app settings", async () => {
    const authState: PasskeyAuthState = {
      passkeyConfigured: false,
      passkeyDisabled: false,
      passkeyRequired: false,
      authenticated: false,
    };

    setupDefaultApi(authState);
    installWebAuthnMocks({
      createResult: createRegistrationCredential(),
    });

    api.get("/api/passkey-auth/registration/options", () => ({
      challenge: "AQID",
      rp: {
        name: "Ralpher",
        id: "example.test",
      },
      user: {
        id: "cmFscGhlcg",
        name: "ralpher",
        displayName: "Ralpher",
      },
      pubKeyCredParams: [{ alg: -7, type: "public-key" }],
    }));
    api.post("/api/passkey-auth/registration/verify", () => {
      authState.passkeyConfigured = true;
      authState.passkeyRequired = true;
      authState.authenticated = true;
      return { success: true };
    }, 200);

    const { user, getByLabelText, getByRole, findByRole } = renderWithUser(<App />, {
      route: "#/settings",
    });

    await waitFor(() => {
      expect(getByRole("heading", { name: "Settings" })).toBeTruthy();
    });

    await user.type(getByLabelText("Passkey name"), "Laptop key");
    await user.click(getByRole("button", { name: "Register passkey" }));

    expect(await findByRole("button", { name: "Remove passkey" })).toBeTruthy();
    expect(api.calls("/api/passkey-auth/registration/options", "GET")).toHaveLength(1);
    expect(api.calls("/api/passkey-auth/registration/verify", "POST")).toHaveLength(1);
    expect(api.calls("/api/passkey-auth/registration/verify", "POST")[0]?.body).toMatchObject({
      name: "Laptop key",
    });
  });

  test("removes the configured passkey from app settings", async () => {
    const authState: PasskeyAuthState = {
      passkeyConfigured: true,
      passkeyDisabled: false,
      passkeyRequired: true,
      authenticated: true,
    };

    setupDefaultApi(authState);
    api.delete("/api/passkey-auth/passkey", () => {
      authState.passkeyConfigured = false;
      authState.passkeyRequired = false;
      authState.authenticated = false;
      return { success: true };
    }, 200);

    const { user, getByRole, findByRole } = renderWithUser(<App />, {
      route: "#/settings",
    });

    await waitFor(() => {
      expect(getByRole("button", { name: "Remove passkey" })).toBeTruthy();
    });

    await user.click(getByRole("button", { name: "Remove passkey" }));
    await waitFor(() => {
      expect(getByRole("heading", { name: "Remove passkey?" })).toBeTruthy();
    });
    const confirmDialog = getByRole("dialog", { name: "Remove passkey?" });
    await user.click(within(confirmDialog).getByRole("button", { name: "Remove passkey" }));

    expect(await findByRole("button", { name: "Register passkey" })).toBeTruthy();
    expect(api.calls("/api/passkey-auth/passkey", "DELETE")).toHaveLength(1);
  });

  test("canceling passkey removal keeps the configured passkey", async () => {
    const authState: PasskeyAuthState = {
      passkeyConfigured: true,
      passkeyDisabled: false,
      passkeyRequired: true,
      authenticated: true,
    };

    setupDefaultApi(authState);
    api.delete("/api/passkey-auth/passkey", () => ({
      success: true,
    }), 200);

    const { user, getByRole, queryByRole } = renderWithUser(<App />, {
      route: "#/settings",
    });

    await waitFor(() => {
      expect(getByRole("button", { name: "Remove passkey" })).toBeTruthy();
    });

    await user.click(getByRole("button", { name: "Remove passkey" }));
    await waitFor(() => {
      expect(getByRole("heading", { name: "Remove passkey?" })).toBeTruthy();
    });

    const confirmDialog = getByRole("dialog", { name: "Remove passkey?" });
    await user.click(within(confirmDialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(queryByRole("heading", { name: "Remove passkey?" })).toBeNull();
      expect(getByRole("button", { name: "Remove passkey" })).toBeTruthy();
    });
    expect(api.calls("/api/passkey-auth/passkey", "DELETE")).toHaveLength(0);
  });

  test("logout returns the browser to the passkey gate", async () => {
    const authState: PasskeyAuthState = {
      passkeyConfigured: true,
      passkeyDisabled: false,
      passkeyRequired: true,
      authenticated: true,
    };

    setupDefaultApi(authState);
    api.post("/api/passkey-auth/logout", () => {
      authState.authenticated = false;
      return { success: true };
    }, 200);

    const { user, getByRole, findByRole } = renderWithUser(<App />, {
      route: "#/settings",
    });

    await waitFor(() => {
      expect(getByRole("button", { name: "Logout" })).toBeTruthy();
    });

    await user.click(getByRole("button", { name: "Logout" }));

    expect(await findByRole("heading", { name: "Unlock Ralpher" })).toBeTruthy();
    expect(api.calls("/api/passkey-auth/logout", "POST")).toHaveLength(1);
  });
});
