import { afterEach, expect, test } from "bun:test";
import { E2EApplication } from "./support/application";
import { createGitFixture } from "./support/git";
import {
  CookieJar,
  createPasskeyRegistration,
} from "./support/passkey";

interface ExecutionHost {
  ref: Record<string, string>;
}

interface ApiKeyResponse {
  token: string;
}

interface UserCreation {
  user: {
    id: string;
    role: string;
    username: string;
  };
  setupLink: {
    url: string;
  };
}

interface Workspace {
  id: string;
  name: string;
}

let application: E2EApplication | undefined;

afterEach(async () => {
  await application?.cleanup();
  application = undefined;
});

async function requestWithCookies(
  app: E2EApplication,
  jar: CookieJar,
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(options.headers);
  const cookie = jar.header();
  if (cookie) {
    headers.set("cookie", cookie);
  }
  const response = await app.request(path, {
    ...options,
    headers,
  });
  jar.absorb(response);
  return response;
}

async function bootstrapOwner(
  app: E2EApplication,
  jar: CookieJar,
): Promise<void> {
  const optionsResponse = await requestWithCookies(
    app,
    jar,
    "/api/passkey-auth/bootstrap/options",
    {
      method: "POST",
      body: JSON.stringify({ username: "e2e-owner" }),
    },
  );
  const optionsBody = await optionsResponse.text();
  if (optionsResponse.status !== 200) {
    throw new Error(`Owner bootstrap options failed (${optionsResponse.status}): ${optionsBody}`);
  }
  const options = JSON.parse(optionsBody) as {
    challenge: string;
    rp: { id?: string };
  };
  const verifyResponse = await requestWithCookies(
    app,
    jar,
    "/api/passkey-auth/bootstrap/verify",
    {
      method: "POST",
      body: JSON.stringify(
        await createPasskeyRegistration(options, app.baseUrl),
      ),
    },
  );
  expect(verifyResponse.status).toBe(200);
}

async function completeUserSetup(
  app: E2EApplication,
  jar: CookieJar,
  token: string,
): Promise<void> {
  const optionsResponse = await requestWithCookies(
    app,
    jar,
    "/api/user-setup/options",
    {
      method: "POST",
      body: JSON.stringify({ token }),
    },
  );
  expect(optionsResponse.status).toBe(200);
  const options = await optionsResponse.json() as {
    challenge: string;
    rp: { id?: string };
  };
  const verifyResponse = await requestWithCookies(
    app,
    jar,
    "/api/user-setup/verify",
    {
      method: "POST",
      body: JSON.stringify({
        token,
        response: await createPasskeyRegistration(options, app.baseUrl),
      }),
    },
  );
  expect(verifyResponse.status).toBe(200);
}

async function createApiKey(
  app: E2EApplication,
  jar: CookieJar,
  name: string,
): Promise<string> {
  const response = await requestWithCookies(app, jar, "/api/api-keys", {
    method: "POST",
    body: JSON.stringify({
      name,
      scopes: ["*"],
    }),
  });
  expect(response.status).toBe(200);
  return (await response.json() as ApiKeyResponse).token;
}

async function createWorkspace(
  app: E2EApplication,
  apiKey: string,
  name: string,
  directory: string,
  executionHost: Record<string, string>,
): Promise<Workspace> {
  return (await app.json<Workspace>(
    "/api/workspaces",
    {
      method: "POST",
      apiKey,
      body: JSON.stringify({
        name,
        directory,
        executionHost,
        serverSettings: {
          agent: {
            adapter: "acp",
            provider: "copilot",
          },
        },
      }),
    },
    201,
  )).data;
}

test("passkey users see only their own Clanky data and permissions", async () => {
  application = await E2EApplication.create();
  try {
    await application.start({
      disablePasskey: false,
      requestHostname: "localhost",
    });
    const ownerCookies = new CookieJar();
    await bootstrapOwner(application, ownerCookies);
    const ownerStatus = await requestWithCookies(
      application,
      ownerCookies,
      "/api/auth/status",
    );
    expect(await ownerStatus.json()).toMatchObject({
      authenticated: true,
      authKind: "passkey",
    });

    const createUserResponse = await requestWithCookies(
      application,
      ownerCookies,
      "/api/users",
      {
        method: "POST",
        body: JSON.stringify({
          username: "e2e-member",
          role: "user",
        }),
      },
    );
    expect(createUserResponse.status).toBe(201);
    const createdUser = await createUserResponse.json() as UserCreation;
    expect(createdUser.user).toMatchObject({
      role: "user",
      username: "e2e-member",
    });

    const memberCookies = new CookieJar();
    const setupToken = new URL(createdUser.setupLink.url).searchParams.get("token");
    expect(setupToken).toBeTruthy();
    await completeUserSetup(application, memberCookies, setupToken!);
    const ownerApiKey = await createApiKey(
      application,
      ownerCookies,
      "owner-e2e",
    );
    const memberApiKey = await createApiKey(
      application,
      memberCookies,
      "member-e2e",
    );

    const ownerHosts = (await application.json<ExecutionHost[]>(
      "/api/execution-hosts",
      { apiKey: ownerApiKey },
    )).data;
    const localHost = ownerHosts.find((host) => host.ref["kind"] === "local");
    expect(localHost).toBeDefined();
    const ownerGit = await createGitFixture(
      `${application.runDirectory}/owner-repository`,
    );
    const memberGit = await createGitFixture(
      `${application.runDirectory}/member-repository`,
    );
    const ownerWorkspace = await createWorkspace(
      application,
      ownerApiKey,
      "Owner private workspace",
      ownerGit.repositoryDirectory,
      localHost!.ref,
    );
    const memberWorkspace = await createWorkspace(
      application,
      memberApiKey,
      "Member private workspace",
      memberGit.repositoryDirectory,
      localHost!.ref,
    );

    expect(
      (await application.json<Workspace[]>(
        "/api/workspaces",
        { apiKey: ownerApiKey },
      )).data.map((workspace) => workspace.id),
    ).toEqual([ownerWorkspace.id]);
    expect(
      (await application.json<Workspace[]>(
        "/api/workspaces",
        { apiKey: memberApiKey },
      )).data.map((workspace) => workspace.id),
    ).toEqual([memberWorkspace.id]);
    expect(
      (await application.request(
        `/api/workspaces/${memberWorkspace.id}`,
        { apiKey: ownerApiKey },
      )).status,
    ).toBe(404);
    expect(
      (await application.request(
        `/api/workspaces/${ownerWorkspace.id}`,
        { apiKey: memberApiKey },
      )).status,
    ).toBe(404);
    expect(
      (await application.request("/api/users", { apiKey: memberApiKey })).status,
    ).toBe(403);
    expect(
      (await application.request("/api/users", { apiKey: ownerApiKey })).status,
    ).toBe(200);

    await application.json(
      `/api/workspaces/${memberWorkspace.id}`,
      {
        method: "DELETE",
        apiKey: memberApiKey,
        body: JSON.stringify({ deleteServerDirectory: false }),
      },
    );
    await application.json(
      `/api/workspaces/${ownerWorkspace.id}`,
      {
        method: "DELETE",
        apiKey: ownerApiKey,
        body: JSON.stringify({ deleteServerDirectory: false }),
      },
    );
    await application.json(
      `/api/users/${createdUser.user.id}`,
      { method: "DELETE", apiKey: ownerApiKey },
    );
    expect(
      (await application.request("/api/workspaces", { apiKey: memberApiKey })).status,
    ).toBe(401);
  } catch (error) {
    const diagnostics = await application.diagnostics();
    if (diagnostics.length > 0) {
      console.error(diagnostics);
    }
    throw error;
  }
});
